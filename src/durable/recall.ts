import type { ConversationId } from '@earendil-works/pi-durable';
import { createOpenAIEmbedder, type EmbedTexts } from '../openai-embeddings.js';
import {
  prepareMemoryQueryEmbeddings, RECALL_CANDIDATE_FILTER, searchHybridMemoriesForQueries, visibleMemoryRevisions,
} from '../memory-semantic.js';
import { mergeTemporalCandidates, searchTemporalMemories } from '../memory-temporal.js';
import { createMemoryRanking, createMemoryUsageTally, type MemoryRanking, type MemoryUsageTally } from '../memory-usage.js';
import {
  RECALL_CANDIDATE_LIMIT, RecallOperationError, runRecallOperation, type RecallCandidate, type RecallFailureStage,
} from '../memory-recall.js';
import type { MemoryRebuildResult } from '../memory-index-refresh.js';
import type { SearchIndex } from '../search-index-types.js';
import type { DateContext } from '../date-context.js';

/** Authority for one hook invocation. Resolved per request from host state, never from ambient process state. */
export interface MemoryScope {
  principalId: string;
  memoryView: 'owner-and-household' | 'household' | 'none';
  /** Explicit per-instance flags and key-file references. Only these values select features. */
  env: Readonly<Record<string, string | undefined>>;
  stateDir: string;
  vaultRoot: string;
  resourceRoot: string;
  /** Legacy and native session roots used when validating core-memory source footnotes. */
  sessionRoots?: readonly string[];
  /** Conversation owning the `bridge.sources` binding document. */
  rootConversationId: ConversationId;
  timeZone: string;
}

/** The derived-index operations recall needs. The search service supplies them. */
export interface MemoryIndexAccess {
  open(scope: MemoryScope): SearchIndex | Promise<SearchIndex>;
  /** Canonical refresh of the memory corpus. Must report completion honestly. */
  refreshMemory(scope: MemoryScope): Promise<MemoryRebuildResult>;
}

export interface RecallServices {
  retrieve(scope: MemoryScope, queries: string[], dates?: DateContext): Promise<RecallCandidate[]>;
  currentRevisions(scope: MemoryScope): Promise<Map<string, string>>;
}

export const INTERACTIVE_REFRESH_BUDGET_MS = 1_500;

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ status: 'fresh'; value: T } | { status: 'timeout' } | { status: 'failed'; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), ms); });
  const settled = promise.then(value => ({ status: 'fresh' as const, value }), error => ({ status: 'failed' as const, error }));
  try { return await Promise.race([settled, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

export interface DomainRecallOptions {
  index: MemoryIndexAccess;
  /** Defaults to the OpenAI embedder selected by scope.env; undefined disables semantic retrieval. */
  embedder?: (scope: MemoryScope) => EmbedTexts | undefined;
  refreshBudgetMs?: number;
  now?: () => number;
  /** Tracks background work so shutdown can wait for it. */
  track?: <T>(promise: Promise<T>) => Promise<T>;
}

/**
 * Same refresh, embed, refresh privacy sequence as the search tool (ADR-0037/0046). Visibility
 * filters, candidate filtering, temporal candidates and the usage ranking come from the shared
 * domain modules; a stale index fails closed.
 */
export function createDomainRecallServices(options: DomainRecallOptions): RecallServices {
  const track = options.track ?? (<T>(promise: Promise<T>) => promise);
  const budget = options.refreshBudgetMs ?? INTERACTIVE_REFRESH_BUDGET_MS;
  const usage = new Map<string, MemoryUsageTally>();
  const requireFresh = async (scope: MemoryScope, stage: RecallFailureStage): Promise<void> => {
    const refresh = await settleWithin(track(Promise.resolve().then(() => options.index.refreshMemory(scope))), budget);
    if (refresh.status === 'timeout') throw new RecallOperationError(stage, 'refresh_timeout');
    if (refresh.status === 'failed') throw new RecallOperationError(stage, 'refresh_failed', refresh.error);
    if (!refresh.value.complete) throw new RecallOperationError(stage, 'refresh_incomplete', undefined, refresh.value);
  };
  const ranking = async (index: SearchIndex, scope: MemoryScope): Promise<MemoryRanking | undefined> => {
    let tally = usage.get(scope.stateDir);
    if (!tally) usage.set(scope.stateDir, tally = createMemoryUsageTally(scope.stateDir));
    try {
      await tally.refresh();
      return createMemoryRanking({ usage: tally, overrides: index.memoryDecayOverrides(), now: (options.now ?? Date.now)() });
    } catch { return undefined; }
  };
  return {
    async retrieve(scope, queries, dates) {
      const index = await runRecallOperation('index_open', () => options.index.open(scope));
      const request = { query: queries[0]!, principal: scope.principalId, memoryView: scope.memoryView, limit: RECALL_CANDIDATE_LIMIT };
      await requireFresh(scope, 'initial_refresh');
      const embedder = options.embedder ? options.embedder(scope) : createOpenAIEmbedder({ env: scope.env as NodeJS.ProcessEnv });
      const semantic = await runRecallOperation('embedding', () => track(prepareMemoryQueryEmbeddings(index, request, queries, embedder)));
      if (semantic.status !== 'disabled') await requireFresh(scope, 'post_embedding_refresh');
      const rank = await ranking(index, scope);
      return runRecallOperation('candidate_search', () => mergeTemporalCandidates(
        searchHybridMemoriesForQueries(index, request, queries, semantic, rank, RECALL_CANDIDATE_FILTER),
        searchTemporalMemories(index, request, dates?.ranges ?? []),
        RECALL_CANDIDATE_LIMIT,
      ).map(match => ({ id: match.id, revision: match.revision, type: match.type, title: match.title, snippet: match.snippet,
        ...(rank ? { drop: rank.drop(match) } : {}) })));
    },
    async currentRevisions(scope) {
      const index = await runRecallOperation('index_open', () => options.index.open(scope));
      await requireFresh(scope, 'revalidation_refresh');
      return runRecallOperation('revision_lookup', () => visibleMemoryRevisions(index, {
        query: 'recall', principal: scope.principalId, memoryView: scope.memoryView,
      }));
    },
  };
}
