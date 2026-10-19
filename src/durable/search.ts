import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { JsonValue } from '@earendil-works/chord';
import { defineTool } from '@earendil-works/pi-durable';
import {
  rebuildMemoryIndex, rebuildSessionIndex, readSessionContext, refreshSessionIndex, SearchInputError, SessionContextError,
  searchIndexedMemories, searchIndexedSessions, type SessionContextResult,
} from '../search-coordinator.js';
import { openSearchIndex, type SearchIndex } from '../search-index.js';
import type { MemoryRebuildResult } from '../memory-index-refresh.js';
import type { SessionDocumentSearchMatch, SessionIndexDocument, SessionSourceState } from '../search-index-types.js';
import { createOpenAIEmbedder } from '../openai-embeddings.js';
import { prepareMemoryEmbeddings, searchHybridMemories, type MemoryEmbeddingPreparation } from '../memory-semantic.js';
import { createMemoryRanking, createMemoryUsageTally, type MemoryRanking, type MemoryUsageTally } from '../memory-usage.js';
import {
  createHistoryResolver, decodeNativeSessionId, encodeNativeSessionId, isNativeSessionId, nativeLocator, parseNativeEntryId,
  type AnchorFinding, type EvidencePolicy, type HistoryLocator, type HistoryResolver, type LegacyAnchor, type NativeHistoryStore,
} from './history.js';
import { DEFAULT_EVIDENCE_POLICY, entryFingerprint, NATIVE_PROJECTION_VERSION, projectNativeEntry } from './history-native.js';
import { textToolResult, type NativeBundle } from './registry.js';

export const INTERACTIVE_REFRESH_BUDGET_MS = 1_500;
const DEFAULT_SESSION_ROLES = ['user', 'assistant'];
const NATIVE_REFRESH_PAGE = 200;
const NATIVE_REFRESH_ENTRY_BUDGET = 20_000;
const MAX_CONTEXT_NEIGHBORS = 5;
const MAX_CONTEXT_ENTRY_CHARS = 1_200;

/** Explicit services for one instance. No ambient environment, process identity or global path is read. */
export interface NativeSearchOptions {
  stateDir: string;
  instanceId: string;
  principalId: string;
  memoryView: 'owner-and-household' | 'household' | 'none';
  vaultRoot: string;
  resourceRoot: string;
  /** Archived read-only JSONL roots. Optional; empty means no legacy evidence. */
  legacySessionRoots?: readonly string[];
  /** Native history stores, resolved lazily because the host exists only after construction. Foreign principals are ignored. */
  stores: () => readonly NativeHistoryStore[];
  /** Feature flags and key-file references for the embedder. */
  env?: Readonly<Record<string, string | undefined>>;
  refreshBudgetMs?: number;
  policy?: EvidencePolicy;
  now?: () => number;
}

export interface SearchEnvelope { ok: boolean; result: unknown; error: { code: string; message: string } | null }
export interface SearchParams { query: string; limit?: number; types?: string[]; statuses?: string[] }
export interface SessionSearchParams { query: string; limit?: number; roles?: string[]; from?: string; to?: string; project?: string }
export interface SessionContextParams { sessionId: string; entryId: string; before?: number; after?: number; maxChars?: number }
export interface IndexOperationParams { operation: 'refresh' | 'rebuild' | 'status'; corpus?: 'memory' | 'session' | 'all' }

export interface NativeSearchService {
  memorySearch(params: SearchParams): Promise<SearchEnvelope>;
  sessionSearch(params: SessionSearchParams): Promise<SearchEnvelope>;
  sessionContext(params: SessionContextParams): Promise<SearchEnvelope>;
  indexOperation(params: IndexOperationParams): Promise<SearchEnvelope>;
  /** Feeds `createDomainRecallServices({ index })`. */
  readonly memoryIndexAccess: { open(): SearchIndex; refreshMemory(): Promise<MemoryRebuildResult> };
  refreshMemory(): Promise<MemoryRebuildResult>;
  refreshSessions(rebuild?: boolean): Promise<{ complete: boolean }>;
  /** Provenance for memory lint: `null` resolves, otherwise a lint finding code. */
  provenanceResolver(anchors: readonly LegacyAnchor[], limits?: { maxBytes: number; maxEntries: number }): Promise<Array<AnchorFinding | null>>;
  readonly history: HistoryResolver;
  /** Lets in-flight work finish, then closes the index. Idempotent. */
  close(): Promise<void>;
}

type Outcome<T> = { status: 'fresh'; value: T } | { status: 'timeout' } | { status: 'failed' };
export async function settleRefreshWithin<T>(promise: Promise<T>, timeoutMs: number, onFailure?: (error: unknown) => void): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome<T>>(done => { timer = setTimeout(() => done({ status: 'timeout' }), timeoutMs); });
  const settled = promise.then<Outcome<T>, Outcome<T>>(value => ({ status: 'fresh', value }), error => { onFailure?.(error); return { status: 'failed' }; });
  try { return await Promise.race([settled, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

const ok = (result: unknown): SearchEnvelope => ({ ok: true, result, error: null });
const failure = (code = 'SEARCH_UNAVAILABLE', message = 'Search is temporarily unavailable'): SearchEnvelope => ({ ok: false, result: null, error: { code, message } });
const nativeNamespace = (instanceId: string, storeId: string) => `native:${instanceId}:${storeId}`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const countOf = (value: number | undefined, label: string, fallback: number): number => {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < 0 || count > MAX_CONTEXT_NEIGHBORS) throw new SearchInputError(`${label} is invalid`);
  return count;
};
const bounded = (value: string, maxChars: number) => {
  const characters = Array.from(value);
  return characters.length <= maxChars ? { text: value, truncated: false } : { text: `${characters.slice(0, Math.max(0, maxChars - 1)).join('')}…`, truncated: true };
};
const validString = (value: string, label: string) => {
  if (value.trim() !== value || value.length === 0 || value.length > 256) throw new SearchInputError(`${label} is invalid`);
  return value;
};

export function createNativeSearch(options: NativeSearchOptions): NativeSearchService {
  const principalId = options.principalId;
  const stateDir = resolve(options.stateDir);
  const policy = options.policy ?? DEFAULT_EVIDENCE_POLICY;
  const budget = options.refreshBudgetMs ?? INTERACTIVE_REFRESH_BUDGET_MS;
  const legacyRoots = (options.legacySessionRoots ?? []).map(root => resolve(root));
  const env = (options.env ?? {}) as NodeJS.ProcessEnv;
  const history = createHistoryResolver({ principal: principalId, nativeStores: options.stores, legacyRoots, policy });
  const stores = () => options.stores().filter(store => store.principal === principalId && store.instanceId === options.instanceId);
  let index: SearchIndex | undefined;
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    const clear = () => { pending.delete(promise); };
    void promise.then(clear, clear);
    return promise;
  };
  const getIndex = (): SearchIndex => {
    if (closed) throw new Error('Search service is closed');
    index ??= openSearchIndex({ stateDir });
    return index;
  };

  const refreshMemory = async (): Promise<MemoryRebuildResult> => {
    const active = getIndex();
    active.recordCorpusAttempt('memory', new Date().toISOString());
    const result = await rebuildMemoryIndex({ index: active, vaultRoot: options.vaultRoot, resourceRoot: options.resourceRoot });
    if (result.complete) active.recordCorpusSuccess('memory', new Date().toISOString());
    return result;
  };

  /** Native documents live in per-store namespaces of the same session tables; legacy refresh never touches them. */
  async function refreshNativeStore(active: SearchIndex, store: NativeHistoryStore): Promise<{ complete: boolean; indexed: number; rebuilt: number; appended: number; deleted: number }> {
    const namespace = nativeNamespace(store.instanceId, store.storeId);
    const visible = new Set(await store.conversations());
    const out = { complete: true, indexed: 0, rebuilt: 0, appended: 0, deleted: 0 };
    for (const state of active.listSessionSourceStates(namespace, principalId)) {
      const conversation = Number(state.sourcePath.slice(store.storeId.length + 1));
      if (!state.sourcePath.startsWith(`${store.storeId}/`) || !visible.has(conversation)) { active.deleteSessionSource(namespace, principalId, state.sourcePath); out.deleted += 1; }
    }
    let remaining = NATIVE_REFRESH_ENTRY_BUDGET;
    for (const conversationId of visible) {
      const sourcePath = `${store.storeId}/${conversationId}`;
      const sessionId = encodeNativeSessionId({ instanceId: store.instanceId, storeId: store.storeId, conversationId });
      const previous = active.getSessionSourceState(namespace, principalId, sourcePath);
      let highWater = previous?.completedOffset ?? 0;
      let replace = previous === undefined;
      if (previous && highWater > 0) {
        const last = await store.entry(conversationId, highWater);
        if (previous.prefixHash !== sha(`${NATIVE_PROJECTION_VERSION}:${entryFingerprint(last)}`)) { replace = true; highWater = 0; }
      }
      let lastFingerprint = highWater > 0 ? entryFingerprint(await store.entry(conversationId, highWater)) : 'absent';
      const documents: SessionIndexDocument[] = [];
      let exhausted = false;
      while (remaining > 0) {
        const want = Math.min(NATIVE_REFRESH_PAGE, remaining);
        const page = await store.scan(conversationId, { minEntryId: highWater + 1, order: 'ascending', limit: want });
        remaining -= page.length;
        for (const entry of page) {
          highWater = entry.id;
          lastFingerprint = entryFingerprint(entry);
          const evidence = projectNativeEntry(entry, policy);
          if (evidence) documents.push({
            instanceId: namespace, principalId, sessionId, entryId: String(evidence.entryId), timestamp: evidence.timestamp, role: evidence.role,
            project: null, cwd: null, sourcePath, sourceOffset: evidence.entryId, searchableText: evidence.text,
          });
        }
        if (page.length < want) { exhausted = true; break; }
      }
      if (!exhausted && remaining <= 0) out.complete = false;
      const state: SessionSourceState = {
        instanceId: namespace, principalId, sourcePath, device: 0, inode: conversationId, sizeBytes: highWater, modifiedMs: 0,
        completedOffset: highWater, prefixHash: sha(`${NATIVE_PROJECTION_VERSION}:${lastFingerprint}`),
        progress: { completion: exhausted ? 'clean-eof' : 'budget-exhausted', warnings: [], warningsTruncated: false },
      };
      if (replace) { active.replaceSessionSource(state, documents); out.rebuilt += 1; }
      else if (documents.length > 0 || highWater !== previous!.completedOffset) { active.appendSessionSource(state, documents); out.appended += 1; }
      out.indexed += documents.length;
    }
    return out;
  }

  const refreshSessions = async (rebuild = false) => {
    const active = getIndex();
    active.recordCorpusAttempt('session', new Date().toISOString());
    let legacy: Record<string, unknown> | undefined;
    let complete = true;
    if (legacyRoots.length > 0) {
      const result = await (rebuild ? rebuildSessionIndex : refreshSessionIndex)({ index: active, roots: legacyRoots, instanceId: options.instanceId, principalId, includeSafeCwd: true });
      legacy = { ...result };
      complete = result.complete;
    }
    const native: Array<Record<string, unknown>> = [];
    for (const store of stores()) {
      const namespace = nativeNamespace(store.instanceId, store.storeId);
      const outcome = await active.withRefreshLock('session', async () => {
        if (rebuild) for (const state of active.listSessionSourceStates(namespace, principalId)) active.deleteSessionSource(namespace, principalId, state.sourcePath);
        return refreshNativeStore(active, store);
      });
      native.push({ storeId: store.storeId, ...outcome });
      complete &&= outcome.complete;
    }
    if (complete) active.recordCorpusSuccess('session', new Date().toISOString());
    return { complete, ...(legacy ? { legacy } : {}), native };
  };

  let usage: MemoryUsageTally | undefined;
  const usageRanking = async (active: SearchIndex): Promise<MemoryRanking | undefined> => {
    usage ??= createMemoryUsageTally(stateDir);
    try {
      await usage.refresh();
      return createMemoryRanking({ usage, overrides: active.memoryDecayOverrides(), now: (options.now ?? Date.now)() });
    } catch { return undefined; }
  };
  const indexStatus = (active: SearchIndex, refresh: Outcome<{ complete: boolean }>) => refresh.status === 'fresh'
    ? { status: refresh.value.complete ? 'fresh' : 'partial', ...refresh.value }
    : { status: 'stale', warning: refresh.status === 'timeout' ? 'refresh_timeout' : 'refresh_failed', corpora: active.corpusStatuses() };
  const errorOf = (error: unknown) => error instanceof SearchInputError || error instanceof SessionContextError ? failure(error.code, error.message) : failure();

  async function memorySearch(params: SearchParams): Promise<SearchEnvelope> {
    return track((async () => {
      try {
        const active = getIndex();
        const request = {
          query: params.query, principal: principalId, memoryView: options.memoryView,
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.types === undefined ? {} : { types: params.types }),
          ...(params.statuses === undefined ? {} : { statuses: params.statuses }),
        };
        searchIndexedMemories(active, request); // validates input before any refresh
        let refresh = await settleRefreshWithin(track(refreshMemory()), budget);
        let semantic: MemoryEmbeddingPreparation = { status: 'disabled' };
        let page: ReturnType<typeof searchHybridMemories> = { results: [], truncated: false };
        if (refresh.status === 'fresh' && refresh.value.complete) {
          semantic = await track(prepareMemoryEmbeddings(active, request, createOpenAIEmbedder({ env })));
          // Network I/O opens a window for canonical edits, including privacy changes.
          if (semantic.status !== 'disabled') refresh = await settleRefreshWithin(track(refreshMemory()), budget);
          if (refresh.status === 'fresh' && refresh.value.complete) page = searchHybridMemories(active, request, semantic, await usageRanking(active));
        }
        return ok({ ...page, retrieval: page.retrieval ?? { mode: 'none', semantic: 'skipped' }, index: indexStatus(active, refresh) });
      } catch (error) { return errorOf(error); }
    })());
  }

  async function currentlyVisible(matches: readonly SessionDocumentSearchMatch[]) {
    const visible = new Map<string, Set<number>>();
    for (const store of stores()) visible.set(store.storeId, new Set(await store.conversations()));
    return matches.filter(match => {
      const identity = decodeNativeSessionId(match.sessionId);
      return identity !== undefined && visible.get(identity.storeId)?.has(identity.conversationId) === true;
    });
  }

  async function sessionSearch(params: SessionSearchParams): Promise<SearchEnvelope> {
    return track((async () => {
      try {
        const active = getIndex();
        const limit = params.limit ?? 10;
        const base = {
          query: params.query, principalId, limit,
          roles: params.roles ?? [...DEFAULT_SESSION_ROLES],
          ...(params.from === undefined ? {} : { from: params.from }),
          ...(params.to === undefined ? {} : { to: params.to }),
        };
        const legacyRequest = { ...base, instanceId: options.instanceId, ...(params.project === undefined ? {} : { project: params.project }) };
        searchIndexedSessions(active, legacyRequest); // input validation
        const refresh = await settleRefreshWithin(track(refreshSessions()), budget);
        let results: Array<Record<string, unknown> & { score: number; timestamp: string }> = [];
        let truncated = false;
        let warning: string | undefined;
        if (refresh.status === 'fresh' && refresh.value.complete) {
          if (legacyRoots.length > 0) {
            const page = searchIndexedSessions(active, legacyRequest);
            results.push(...page.results.map(result => ({ ...result, backend: 'jsonl' })));
            truncated ||= page.truncated;
            warning ??= page.warning;
          }
          // Native evidence has no project; a project filter selects archived sessions only.
          if (params.project === undefined) for (const store of stores()) {
            const page = searchIndexedSessions(active, { ...base, instanceId: nativeNamespace(store.instanceId, store.storeId) });
            const visible = await currentlyVisible(page.results);
            results.push(...visible.map(({ sourcePath: _path, sourceOffset: _offset, ...result }) => {
              const identity = decodeNativeSessionId(result.sessionId)!;
              const locator: HistoryLocator = nativeLocator(identity, { entryId: Number(result.entryId), timestamp: result.timestamp });
              return { ...result, backend: 'durable', locator };
            }));
            truncated ||= page.truncated;
            warning ??= page.warning;
          }
          results.sort((a, b) => b.score - a.score || (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
          if (results.length > limit) { truncated = true; results = results.slice(0, limit); }
        }
        return ok({ results, truncated, ...(warning ? { warning } : {}), index: indexStatus(active, refresh) });
      } catch (error) { return errorOf(error); }
    })());
  }

  async function sessionContext(params: SessionContextParams): Promise<SearchEnvelope> {
    try {
      const sessionId = validString(params.sessionId, 'Session context session ID');
      const entryId = validString(params.entryId, 'Session context entry ID');
      const before = countOf(params.before, 'Session context before count', 2);
      const after = countOf(params.after, 'Session context after count', 2);
      const maxChars = params.maxChars ?? 4_000;
      if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 12_000) throw new SearchInputError('Session context character budget is invalid');
      if (!isNativeSessionId(sessionId)) {
        if (legacyRoots.length === 0) throw new SessionContextError('Session context entry was not found in the index');
        const result: SessionContextResult = await readSessionContext(getIndex(), { sessionId, entryId, instanceId: options.instanceId, principalId, roots: legacyRoots, before, after, maxChars });
        return ok({ ...result, entries: result.entries.map(entry => ({ ...entry, backend: 'jsonl' })) });
      }
      if (decodeNativeSessionId(sessionId) === undefined || parseNativeEntryId(entryId) === undefined) throw new SearchInputError('Session context entry ID is invalid');
      const window = await history.readNativeContext(sessionId, entryId, before, after);
      if (!window) throw new SessionContextError('Session context entry was not found');
      const selected = [...window.before, window.target, ...window.after];
      const per = Math.max(1, Math.floor(maxChars / selected.length));
      const entries = selected.map(evidence => {
        const text = bounded(evidence.text, Math.min(MAX_CONTEXT_ENTRY_CHARS, per));
        return {
          entryId: String(evidence.entryId), timestamp: evidence.timestamp, role: evidence.role, backend: 'durable',
          locator: nativeLocator(window.identity, evidence), isTarget: evidence.entryId === window.target.entryId,
          text: text.text, truncated: evidence.truncated || text.truncated,
        };
      });
      return ok({
        sessionId, targetEntryId: entryId, entries, beforeReturned: window.before.length, afterReturned: window.after.length,
        hasMoreBefore: window.hasMoreBefore, hasMoreAfter: window.hasMoreAfter, truncated: entries.some(entry => entry.truncated),
      });
    } catch (error) { return errorOf(error); }
  }

  async function indexOperation(params: IndexOperationParams): Promise<SearchEnvelope> {
    return track((async () => {
      try {
        const active = getIndex();
        if (params.operation === 'status') return ok({ ...active.status(), corpora: active.corpusStatuses() });
        const corpus = params.corpus ?? 'all';
        const result: Record<string, unknown> = {};
        if (corpus === 'memory' || corpus === 'all') {
          const memory = await track(refreshMemory());
          result.memory = memory;
          if (memory.complete) {
            const semantic = await track(prepareMemoryEmbeddings(active, { query: 'memory', principal: principalId, memoryView: options.memoryView }, createOpenAIEmbedder({ env }), false));
            result.semantic = { status: semantic.status };
          }
        }
        if (corpus === 'session' || corpus === 'all') result.session = await track(refreshSessions(params.operation === 'rebuild'));
        return ok({ ...result, status: { ...active.status(), corpora: active.corpusStatuses() } });
      } catch (error) { return errorOf(error); }
    })());
  }

  return {
    memorySearch, sessionSearch, sessionContext, indexOperation, refreshMemory, refreshSessions, history,
    memoryIndexAccess: { open: getIndex, refreshMemory: () => refreshMemory() },
    provenanceResolver: (anchors, limits) => history.resolveAnchors(anchors, limits),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...pending]);
      index?.close();
      index = undefined;
    },
  };
}

const MemoryType = StringEnum(['person', 'preference', 'event', 'list', 'recipe', 'purchase', 'reference'] as const);
const MemoryStatus = StringEnum(['active', 'superseded', 'archived'] as const);
const SessionRole = StringEnum(['user', 'assistant', 'toolResult'] as const);
const Corpus = StringEnum(['memory', 'session', 'all'] as const);
const Operation = StringEnum(['refresh', 'rebuild', 'status'] as const);

const MEMORY_DESCRIPTION = 'Search canonical personal-memory notes with keyword and, when configured, semantic retrieval. Returns stable note IDs, revisions, metadata, bounded snippets, and retrieval status.';
const SESSION_DESCRIPTION = 'Search original Pi/Telegram session evidence through the isolated private FTS index. Returns stable session and entry anchors with bounded snippets. Archived and native evidence use the same sessionId, entryId and timestamp citation fields.';
const CONTEXT_DESCRIPTION = 'Read a bounded window around one session-search result. Use the session and entry IDs returned by assistant_session_search; this returns nearby turns, not the whole conversation.';
const INDEX_DESCRIPTION = 'Inspect, refresh, or rebuild the private derived memory/session search index. The canonical Markdown, JSONL and native sources are never modified.';

/** Read-only tools: a restart may safely rerun them. */
export function createSearchBundle(service: NativeSearchService, name = 'search'): NativeBundle {
  const run = (envelope: Promise<SearchEnvelope>) => envelope.then(value => ({ ...textToolResult(JSON.stringify(value)), details: value as unknown as JsonValue, isError: !value.ok }));
  return {
    name, version: 1,
    tools: [
      { version: 1, tool: defineTool({
        name: 'assistant_memory_search', description: MEMORY_DESCRIPTION, replay: 'safe',
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 512 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          types: Type.Optional(Type.Array(MemoryType, { minItems: 1, maxItems: 7 })),
          statuses: Type.Optional(Type.Array(MemoryStatus, { minItems: 1, maxItems: 3 })),
        }),
        execute: args => run(service.memorySearch(args)),
      }) },
      { version: 1, tool: defineTool({
        name: 'assistant_session_search', description: SESSION_DESCRIPTION, replay: 'safe',
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 512 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
          roles: Type.Optional(Type.Array(SessionRole, { minItems: 1, maxItems: 3 })),
          from: Type.Optional(Type.String({ maxLength: 30 })), to: Type.Optional(Type.String({ maxLength: 30 })),
          project: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        }),
        execute: args => run(service.sessionSearch(args)),
      }) },
      { version: 1, tool: defineTool({
        name: 'session_context', description: CONTEXT_DESCRIPTION, replay: 'safe',
        parameters: Type.Object({
          sessionId: Type.String({ minLength: 1, maxLength: 256 }), entryId: Type.String({ minLength: 1, maxLength: 256 }),
          before: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })), after: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
          maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 12_000 })),
        }),
        execute: args => run(service.sessionContext(args)),
      }) },
      { version: 1, tool: defineTool({
        name: 'search_index', description: INDEX_DESCRIPTION, replay: 'safe',
        parameters: Type.Object({ operation: Operation, corpus: Type.Optional(Corpus) }),
        execute: args => run(service.indexOperation(args)),
      }) },
    ],
    close: () => service.close(),
  };
}
