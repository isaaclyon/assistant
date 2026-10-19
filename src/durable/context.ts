import type { Context } from '@earendil-works/chord/context';
import type { Message, UserMessage } from '@earendil-works/pi-ai';
import { GenerationTask, defineDoc, hook, type EntryRecord, type Harness, type HookApi } from '@earendil-works/pi-durable';
import { isFeatureEnabled } from '../feature-flags.js';
import {
  appendRecallLog, classifyRecallPrompt, MEMORY_RECALL_MESSAGE_TYPE, recallMemories, type RecallMessage, type RecallLogRecord,
} from '../memory-recall.js';
import { createTypeSafeJudge, type SemanticJudge } from '../semantic-judge.js';
import { Bindings } from './ingress.js';
import type { NativeBundle } from './registry.js';
import { compileScopedCoreMemory } from './core-memory.js';
import { renderDateContext, resolveTurnDates, type DateContext } from './date.js';
import type { MemoryScope, RecallServices } from './recall.js';

export const CONTEXT_BUNDLE_NAME = 'core-memory';
export const CONTEXT_BUNDLE_VERSION = 1;
export const SOURCE_ENTRY_KIND = 'bridge.source';
/** Retained hidden-context records per conversation. Older sources fall out of the ledger. */
export const LEDGER_TURN_LIMIT = 256;
const CORE_TEXT_LIMIT = 16_000;

export type TurnContextRecord = {
  /** Original accepted human event time. */
  at: number;
  /** Hidden model context: date hints followed by recalled notes and proposal flags. Empty when none. */
  text: string;
  /** `id`/`revision` pairs this turn injected; the dedup set is rebuilt from retained turns only. */
  notes: Array<{ id: string; revision: string }>;
};
export type ContextLedgerState = {
  turns: Record<string, TurnContextRecord>;
  order: string[];
  /** Core memory for the newest turn, so tool rounds of one turn share one prompt. */
  core?: { key: string; text: string };
};
/**
 * Hidden-context ledger. It is a document, not a transcript entry: it is never part of the
 * conversation history that search indexes or Telegram renders, and the model sees it only
 * through request-time injection.
 */
export const ContextLedger = defineDoc<ContextLedgerState>({
  kind: 'bridge.context', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ turns: {}, order: [] }),
});

export interface ContextBundleOptions {
  /** Current authority for this request. Undefined disables every injection (outside current epoch, revoked). */
  scope(api: HookApi, context: Context): Promise<MemoryScope | undefined>;
  /** Public Harness handle, resolved lazily because the host creates it after the registry. */
  harness(): Harness;
  /** Candidate retrieval for automatic recall. Absent disables recall (dates and core memory remain). */
  recall?: RecallServices;
  judge?(scope: MemoryScope): SemanticJudge;
  /** Defaults to the instance's memory-recall.jsonl (identifiers and probabilities only). */
  log?(scope: MemoryScope, record: RecallLogRecord): Promise<void>;
  /** Diagnostics sink; never contains credentials. */
  debug?(title: string, value: unknown): void;
  /** Reports hook failures. The request always proceeds unchanged for the failed part. */
  onError?(stage: string, error: unknown): void;
  /** Tracks background work for shutdown. */
  track?<T>(promise: Promise<T>): Promise<T>;
}

interface AlignedUser { index: number; entry: EntryRecord; message: UserMessage }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function plainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => { const b = asRecord(block); return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''; }).filter(Boolean).join('\n');
}
function sameMessage(a: UserMessage, b: UserMessage): boolean {
  return a.timestamp === b.timestamp && JSON.stringify(a.content) === JSON.stringify(b.content);
}
function sourceOf(entry: EntryRecord): { sourceId: string; originalAt: number } | undefined {
  if (entry.kind !== SOURCE_ENTRY_KIND) return undefined;
  const data = asRecord(entry.data);
  if (!data || typeof data.sourceId !== 'string' || !data.sourceId || !Number.isSafeInteger(data.originalAt) || (data.originalAt as number) <= 0) return undefined;
  return { sourceId: data.sourceId, originalAt: data.originalAt as number };
}
const isFlagOn = (scope: MemoryScope, onError: ContextBundleOptions['onError']): boolean => {
  // A misspelled flag must not enable or crash anything: treat as off and report.
  try { return isFeatureEnabled('PI_TELEGRAM_MEMORY_RECALL', scope.env); } catch (error) { onError?.('flag', error); return false; }
};

/**
 * Native replacement for the legacy core-memory, date-context and automatic-recall extensions.
 * One generation `beforeRequest` hook returns request-only messages: nothing is written to
 * the transcript, so hidden context is never indexed as user speech or sent to Telegram.
 * The hook recomputes from committed state on each request attempt and persists one record
 * per accepted source in `bridge.context`, so repeated requests, tool rounds, retries and
 * recovery inject the same text exactly once.
 */
export function createContextBundle(options: ContextBundleOptions): NativeBundle {
  const track = options.track ?? (<T>(promise: Promise<T>) => promise);
  const pending = new Set<Promise<unknown>>();
  const inflight = new Map<string, Promise<unknown>>();
  let closed = false;
  const once = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = work().finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  };

  async function buildTurnRecord(
    scope: MemoryScope, api: HookApi, context: Context, view: { entries: readonly EntryRecord[]; contributions: readonly (readonly Message[])[] },
    current: AlignedUser, source: { sourceId: string; originalAt: number }, ledger: ContextLedgerState,
  ): Promise<TurnContextRecord> {
    const empty: TurnContextRecord = { at: source.originalAt, text: '', notes: [] };
    const bindings = await api.snapshot(Bindings, scope.rootConversationId, context).catch(() => undefined);
    const binding = bindings?.sources[source.sourceId];
    // Without a host binding the message is not an accepted source; add nothing for it.
    if (!binding || binding.conversationId !== api.conversationId) return empty;
    const body = plainText(current.message.content);
    // Heartbeats, webhooks and child completions carry external content: skipped, as in legacy.
    const trigger = binding.proactive ? classifyRecallPrompt(body) : 'telegram' as const;
    if (!trigger) return empty;
    const dates: DateContext | undefined = trigger === 'telegram' ? resolveTurnDates(body, { originalAt: source.originalAt, timeZone: scope.timeZone }) : undefined;
    const dateText = dates ? renderDateContext(dates) : '';
    if (dateText) options.debug?.('Automatic date context', dateText);
    let recalled: RecallMessage | undefined;
    if (!options.recall) options.debug?.('Automatic memory recall', 'Recall services unavailable.');
    else if (!isFlagOn(scope, options.onError)) options.debug?.('Automatic memory recall', 'Disabled for this instance.');
    else if (scope.memoryView === 'none') options.debug?.('Automatic memory recall', 'No memory view for this instance.');
    else {
      // Legacy-shaped entries let the shared recall pipeline build its window and dedup set.
      const legacy: unknown[] = [];
      const entries = view.entries;
      for (let i = 0; i < entries.length && entries[i]!.id !== current.entry.id; i += 1) {
        const entry = entries[i]!;
        const earlier = sourceOf(entry);
        for (const message of view.contributions[i] ?? []) {
          if (message.role === 'assistant') legacy.push({ type: 'message', message: { role: 'assistant', content: message.content } });
          else if (message.role === 'user' && earlier && bindings?.sources[earlier.sourceId]?.proactive === false) {
            legacy.push({ type: 'message', message: { role: 'user', content: `[telegram] ${plainText(message.content)}` } });
            const retained = ledger.turns[earlier.sourceId];
            if (retained?.notes.length) legacy.push({ type: 'custom_message', customType: MEMORY_RECALL_MESSAGE_TYPE, details: { notes: retained.notes } });
          }
        }
      }
      const index = options.recall;
      const judge = options.judge ? options.judge(scope) : createTypeSafeJudge({ env: scope.env as NodeJS.ProcessEnv, timeoutMs: 3_000, maxAttempts: 1 });
      recalled = await track(recallMemories({
        prompt: trigger === 'telegram' ? `[telegram] ${body}` : body,
        entries: legacy,
        sessionId: String(api.conversationId),
        ...(dates ? { dates } : {}),
      }, {
        retrieve: queries => index.retrieve(scope, queries, dates),
        currentRevisions: () => index.currentRevisions(scope),
        judge,
        log: record => {
          options.debug?.('Automatic memory recall decisions', record);
          return (options.log ? options.log(scope, record) : appendRecallLog(scope.stateDir, record));
        },
      }));
      if (recalled) options.debug?.('Automatically recalled context', recalled.content);
    }
    const text = [dateText, recalled?.content].filter(Boolean).join('\n\n');
    return { at: source.originalAt, text, notes: recalled?.details.notes ?? [] };
  }

  async function inject(messages: readonly Message[], api: HookApi, context: Context): Promise<{ messages: readonly Message[] } | undefined> {
    if (closed) return undefined;
    const scope = await options.scope(api, context);
    if (!scope) return undefined;
    const conversation = await options.harness().conversation(api.conversationId, context);
    if (!conversation) return undefined;
    const view = await conversation.context(context);
    // Align this request's user messages with committed entries; any disagreement skips the turn.
    const viewUsers: Array<{ entry: EntryRecord; message: UserMessage }> = [];
    view.entries.forEach((entry, i) => { for (const message of view.contributions[i] ?? []) if (message.role === 'user') viewUsers.push({ entry, message }); });
    const aligned: AlignedUser[] = [];
    let ok = true;
    let userIndex = 0;
    messages.forEach((message, index) => {
      if (message.role !== 'user') return;
      const candidate = viewUsers[userIndex++];
      if (!candidate || !sameMessage(candidate.message, message)) { ok = false; return; }
      aligned.push({ index, entry: candidate.entry, message });
    });
    const fresh = (await api.snapshot(ContextLedger, api.conversationId, context)) as unknown as ContextLedgerState | undefined;
    const ledger: ContextLedgerState = fresh ? structuredClone(fresh) as ContextLedgerState : { turns: {}, order: [] };
    const last = ok ? aligned.at(-1) : undefined;
    const coreKey = last ? String(last.entry.id) : undefined;

    // Core memory: once per turn, fresh at the turn's first request.
    let core = coreKey !== undefined && ledger.core?.key === coreKey ? ledger.core.text : undefined;
    let coreChanged = false;
    if (core === undefined) {
      try {
        const compiled = await compileScopedCoreMemory(scope);
        core = compiled.text.length <= CORE_TEXT_LIMIT ? compiled.text : '';
        options.debug?.('Automatic core memory', core || 'No core memory to inject.');
        coreChanged = coreKey !== undefined;
      } catch (error) { options.onError?.('core', error); core = ''; }
    }

    // Per-turn hidden context for the newest accepted source.
    const source = last ? sourceOf(last.entry) : undefined;
    let record = source ? ledger.turns[source.sourceId] : undefined;
    let recordChanged = false;
    if (last && source && !record) {
      record = await once(`${api.conversationId}:${source.sourceId}`, () => buildTurnRecord(scope, api, context, view, last, source, ledger));
      recordChanged = true;
    }
    if (coreChanged || recordChanged) {
      const commit = async () => conversation.commit(async tx => {
        const state = (await tx.doc(ContextLedger, api.conversationId)) as unknown as ContextLedgerState;
        if (coreChanged && coreKey !== undefined) state.core = { key: coreKey, text: core! };
        if (recordChanged && source && record && !state.turns[source.sourceId]) {
          state.turns[source.sourceId] = record;
          state.order.push(source.sourceId);
          while (state.order.length > LEDGER_TURN_LIMIT) delete state.turns[state.order.shift()!];
        }
      }, context);
      try { await track(commit()); } catch (error) { options.onError?.('ledger', error); }
    }

    // Build the request: retained turns keep their hidden context after their user message.
    const hiddenAfter = new Map<number, string>();
    if (ok) for (const turn of aligned) {
      const s = sourceOf(turn.entry);
      const r = s && (s.sourceId === source?.sourceId ? record : ledger.turns[s.sourceId]);
      if (r?.text) hiddenAfter.set(turn.index, r.text);
    }
    if (!core && hiddenAfter.size === 0) return undefined;
    const output: Message[] = [];
    let coreApplied = false;
    messages.forEach((message, index) => {
      if (!coreApplied && message.role === 'system' && core) {
        coreApplied = true;
        const content = message.content;
        if (typeof content === 'string') output.push({ ...message, content: content.endsWith(core) ? content : content + core });
        else if (content.at(-1)?.text.endsWith(core)) output.push(message);
        else output.push({ ...message, content: [...content, { type: 'text', text: core }] });
      } else output.push(message);
      const hidden = hiddenAfter.get(index);
      if (hidden && message.role === 'user') {
        const next = messages[index + 1];
        // Idempotent when another hook already supplied this exact hidden message.
        if (!(next?.role === 'user' && plainText(next.content) === hidden)) output.push({ role: 'user', content: hidden, timestamp: message.timestamp });
      }
    });
    if (!coreApplied && core) output.unshift({ role: 'system', content: core.trim(), timestamp: Date.now() });
    return { messages: output };
  }

  const beforeRequest = async (request: { readonly messages: readonly Message[] }, api: HookApi, context: Context) => {
    const work = inject(request.messages, api, context);
    pending.add(work);
    try { return await work; }
    catch (error) { options.onError?.('request', error); return undefined; }
    finally { pending.delete(work); }
  };

  return {
    name: CONTEXT_BUNDLE_NAME,
    version: CONTEXT_BUNDLE_VERSION,
    tools: [],
    contributions: { hooks: [hook(GenerationTask, { beforeRequest })] },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
