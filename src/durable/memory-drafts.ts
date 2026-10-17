import { defineDoc, type ConversationId, type JsonObject, type Tx } from '@earendil-works/pi-durable';
import type { MemoryBinding } from './operations.js';
import type { MemoryDraft } from './memory-domain.js';

/** One reviewed draft. Binding values come from trusted host state, never from model arguments. */
export type DraftRecord = {
  token: string;
  /** Allocated with the draft so every retry of the token targets the same note id. */
  noteId: string;
  draft: JsonObject;
  principal: string;
  target: MemoryBinding['target'];
  epoch: string;
  createdAt: number;
  expiresAt: number;
  /** Set in the same commit that prepares and authorizes the creation operation. */
  consumed: { operationId: string; at: number } | null;
};
export type MemoryDraftState = { version: number; epoch: string | null; drafts: DraftRecord[] };
export const MemoryDrafts = defineDoc<MemoryDraftState>({
  kind: 'assistant.memory-drafts', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ version: 1, epoch: null, drafts: [] }),
});
export const DRAFT_TTL_MS = 10 * 60_000;
export const MAX_OUTSTANDING_DRAFTS = 32;
/** Consumed records stay long enough to answer an idempotent retry, then give way. */
const MAX_CONSUMED_RECORDS = 64;

export function draftOf(record: DraftRecord): MemoryDraft { return record.draft as unknown as MemoryDraft; }

function checkVersion(state: MemoryDraftState): void {
  if (state.version !== 1) throw new Error('Unsupported memory draft document version');
}

/** Under the commit: adopt the current epoch, drop stale or expired pending drafts, bound the log. */
export function pruneDrafts(state: MemoryDraftState, epoch: string, now: number): void {
  checkVersion(state);
  if (state.epoch !== epoch) state.epoch = epoch;
  state.drafts = state.drafts.filter(d => d.consumed ? true : d.epoch === epoch && d.expiresAt > now);
  const consumed = state.drafts.filter(d => d.consumed);
  if (consumed.length > MAX_CONSUMED_RECORDS) {
    const drop = new Set(consumed.slice(0, consumed.length - MAX_CONSUMED_RECORDS).map(d => d.token));
    state.drafts = state.drafts.filter(d => !drop.has(d.token));
  }
  const pending = state.drafts.filter(d => !d.consumed);
  if (pending.length >= MAX_OUTSTANDING_DRAFTS) {
    const drop = new Set(pending.slice(0, pending.length - MAX_OUTSTANDING_DRAFTS + 1).map(d => d.token));
    state.drafts = state.drafts.filter(d => !drop.has(d.token));
  }
}

/** New, reload and reset invalidate unconsumed drafts. Restart within one epoch does not call this. */
export async function invalidateMemoryDrafts(tx: Tx, conversationId: ConversationId, nextEpoch: string): Promise<void> {
  const state = await tx.doc(MemoryDrafts, conversationId);
  checkVersion(state);
  // Reload expires pending drafts without rotating the conversation epoch.
  // The operation layer enforces a fresh epoch for an actual /new.
  if (!nextEpoch) throw new Error('Invalidation requires an epoch');
  state.epoch = nextEpoch;
  state.drafts = state.drafts.filter(d => d.consumed);
}
