import { createHash } from 'node:crypto';
import type { ConversationId, EntryId } from '@earendil-works/pi-durable';
import { extractText, truncateUtf8 } from '../session-jsonl-parser.js';
import { Bindings, context, type IngressRuntime } from './ingress.js';

/** Bump when the evidence projection changes; derived indexes then rebuild their native sources. */
export const NATIVE_PROJECTION_VERSION = 1;
const MAX_BLOCK_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;

export type EvidenceRole = 'user' | 'assistant' | 'toolResult';

/** One immutable native transcript entry, reduced to the fields evidence needs. */
export interface NativeHistoryEntry {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly model?: readonly unknown[];
  readonly data?: unknown;
}

/**
 * Read-only access to one native store, already bound to one instance and principal.
 * `conversations()` is evaluated at call time, so every read rechecks current visibility.
 */
export interface NativeHistoryStore {
  readonly instanceId: string;
  readonly storeId: string;
  readonly principal: string;
  /** Conversations whose bound sources all belong to this instance and principal. */
  conversations(): Promise<readonly number[]>;
  /** Entries of one conversation within inclusive id bounds; `limit` is bounded by the caller. */
  scan(conversationId: number, query: { minEntryId?: number; maxEntryId?: number; order: 'ascending' | 'descending'; limit: number }): Promise<readonly NativeHistoryEntry[]>;
  entry(conversationId: number, entryId: number): Promise<NativeHistoryEntry | undefined>;
}

export interface NativeEvidence {
  entryId: number;
  conversationId: number;
  /** Source event time for admitted input; message time otherwise. Never the admission time of input. */
  timestamp: string;
  role: EvidenceRole;
  text: string;
  truncated: boolean;
}

export interface EvidencePolicy {
  /** Entry kinds whose user message is human or admitted-source evidence. Everything else is hidden context. */
  userKinds: readonly string[];
  /** Tool results from these tools may hold credentials or form contents and are never evidence. */
  excludedTools: ReadonlySet<string>;
}
export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = Object.freeze({
  userKinds: ['bridge.source'],
  excludedTools: new Set(['private_browser_login', 'private_browser_input', 'browser_takeover', 'private_opentable_login']),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function iso(milliseconds: unknown): string | undefined {
  if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds) || milliseconds < 0) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
/** An explicit marker keeps a future hidden writer out even if it reuses an allowed kind. */
function markedHidden(data: unknown): boolean {
  return isRecord(data) && (data.hidden === true || data.visibility === 'hidden' || typeof data.customType === 'string' || data.control === true);
}

/**
 * Evidence is an allowlist. System prompts, date/core/recall context, controls, compaction summaries,
 * resets, thinking, tool calls and unsafe text never become searchable user evidence.
 */
export function projectNativeEntry(entry: NativeHistoryEntry, policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY): NativeEvidence | undefined {
  if (!Number.isSafeInteger(entry.id) || entry.id < 1 || !Number.isSafeInteger(entry.conversationId) || entry.conversationId < 1) return undefined;
  if (markedHidden(entry.data)) return undefined;
  const message = entry.model?.length === 1 ? entry.model[0] : undefined;
  if (!isRecord(message)) return undefined;
  let role: EvidenceRole;
  let timestamp = iso(message.timestamp);
  if (entry.kind === 'pi.assistant' && message.role === 'assistant') role = 'assistant';
  else if (entry.kind === 'pi.tool-result' && message.role === 'toolResult') {
    if (typeof message.toolName === 'string' && policy.excludedTools.has(message.toolName)) return undefined;
    role = 'toolResult';
  } else if (policy.userKinds.includes(entry.kind) && message.role === 'user') {
    role = 'user';
    if (isRecord(entry.data) && entry.data.originalAt !== undefined) {
      // Source time is authoritative; an invalid recorded value makes the anchor unusable, not approximate.
      timestamp = iso(entry.data.originalAt);
    }
  } else return undefined;
  if (timestamp === undefined) return undefined;
  const blocks = extractText(message.content, MAX_BLOCK_BYTES);
  const limited = truncateUtf8(blocks.map(block => block.text).join('\n'), MAX_ENTRY_BYTES);
  if (!limited.text) return undefined;
  return { entryId: entry.id, conversationId: entry.conversationId, timestamp, role, text: limited.text, truncated: blocks.some(block => block.truncated) || limited.truncated };
}

/** Stable fingerprint of one scanned entry's content; a restored or replaced store changes it. */
export function entryFingerprint(entry: NativeHistoryEntry | undefined): string {
  return entry === undefined ? 'absent' : createHash('sha256').update(`${NATIVE_PROJECTION_VERSION}:${entry.id}:${entry.conversationId}:${entry.kind}:${JSON.stringify([entry.model ?? null, entry.data ?? null])}`).digest('hex');
}

export interface HarnessHistoryIdentity {
  instanceId: string;
  storeId: string;
  principal: string;
}
const PAGE = 100;

/**
 * Adapter over the live host's Harness. Visibility follows the durable source bindings: a conversation
 * is readable only when every bound source belongs to this instance and principal.
 */
export function createHarnessHistoryStore(runtime: Pick<IngressRuntime, 'harness' | 'root' | 'store'>, identity: HarnessHistoryIdentity): NativeHistoryStore {
  const { storage } = runtime.store;
  const asConversation = (id: number) => id as unknown as ConversationId;
  const asEntry = (id: number) => id as unknown as EntryId;
  const toEntry = (entry: { id: unknown; conversationId: unknown; kind: string; model?: readonly unknown[]; data?: unknown }): NativeHistoryEntry => ({
    id: entry.id as number, conversationId: entry.conversationId as number, kind: entry.kind,
    ...(entry.model === undefined ? {} : { model: entry.model }), ...(entry.data === undefined ? {} : { data: entry.data }),
  });
  return {
    ...identity,
    async conversations() {
      const state = await runtime.harness.snapshot(Bindings, runtime.root.id, context);
      const visible: number[] = [];
      for (const conversation of new Set(Object.values(state?.epochs ?? {}))) {
        const sources = Object.values(state?.sources ?? {}).filter(source => source.conversationId === conversation);
        if (sources.length > 0 && sources.every(source => source.principal === identity.principal && source.envelope.instance === identity.instanceId)) visible.push(conversation as unknown as number);
      }
      return visible.sort((a, b) => a - b);
    },
    async scan(conversationId, query) {
      const collected: NativeHistoryEntry[] = [];
      let cursor: Record<string, never> | undefined;
      while (collected.length < query.limit) {
        const page = await storage.scanEntries({
          conversationId: asConversation(conversationId), order: query.order,
          ...(query.minEntryId === undefined ? {} : { minEntryId: asEntry(query.minEntryId) }),
          ...(query.maxEntryId === undefined ? {} : { maxEntryId: asEntry(query.maxEntryId) }),
        }, Math.min(PAGE, query.limit - collected.length), cursor as never, context);
        for (const entry of page.items) collected.push(toEntry(entry));
        if (page.next === undefined) break;
        cursor = page.next as never;
      }
      return collected.filter(entry => entry.conversationId === conversationId);
    },
    async entry(conversationId, entryId) {
      const found = await storage.entry(asConversation(conversationId), asEntry(entryId), context);
      return found && (found.entry.conversationId as unknown as number) === conversationId ? toEntry(found.entry) : undefined;
    },
  };
}
