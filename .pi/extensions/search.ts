import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";

import {
  rebuildMemoryIndex,
  rebuildSessionIndex,
  readSessionContext,
  refreshSessionIndex,
  SearchInputError,
  SessionContextError,
  searchIndexedMemories,
  searchIndexedSessions,
} from "../../src/search-coordinator.ts";
import { openSearchIndex, type SearchIndex } from "../../src/search-index.ts";
import { createOpenAIEmbedder } from "../../src/openai-embeddings.ts";
import {
  prepareMemoryEmbeddings,
  prepareMemoryQueryEmbeddings,
  searchHybridMemories,
  searchHybridMemoriesForQueries,
  visibleMemoryRevisions,
  type MemoryEmbeddingPreparation,
} from "../../src/memory-semantic.ts";
import {
  appendRecallLog,
  classifyRecallPrompt,
  isMemoryRecallEnabled,
  recallMemories,
  RECALL_CANDIDATE_LIMIT,
  type RecallCandidate,
} from "../../src/memory-recall.ts";
import { createTypeSafeJudge } from "../../src/semantic-judge.ts";
import { isBridgeRuntime } from "../lib/bridge-runtime.ts";

const MemoryTypeSchema = StringEnum([
  "person",
  "preference",
  "event",
  "list",
  "recipe",
  "purchase",
  "reference",
] as const);
const MemoryStatusSchema = StringEnum(["active", "superseded", "archived"] as const);
const SessionRoleSchema = StringEnum(["user", "assistant", "toolResult"] as const);
const CorpusSchema = StringEnum(["memory", "session", "all"] as const);
const OperationSchema = StringEnum(["refresh", "rebuild", "status"] as const);
const INTERACTIVE_REFRESH_BUDGET_MS = 1_500;
const DEFAULT_SESSION_ROLES = ["user", "assistant"] as const;

interface SearchContext {
  stateDir: string;
  instanceId: string;
  principalId: string;
  memoryView: "owner-and-household" | "household" | "none";
  vaultRoot: string;
  sessionRoots: string[];
  resourceRoot: string;
}

interface SearchToolDetails {
  ok: boolean;
  result: unknown;
  error: { code: string; message: string } | null;
}

function resolveContext(): SearchContext {
  const stateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR?.trim();
  const principalId = process.env.PI_TELEGRAM_PRINCIPAL?.trim();
  const memoryView = process.env.PI_TELEGRAM_MEMORY_VIEW?.trim();
  const vaultRoot =
    process.env.PI_TELEGRAM_MEMORY_DIR?.trim() ??
    join(homedir(), ".local", "share", "pi-telegram-bridge", "memory");
  const activeSessionRoot =
    process.env.PI_TELEGRAM_BRIDGE_SESSION_DIR?.trim();
  const resourceRoot =
    process.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT?.trim() ?? process.cwd();
  const instanceId = process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID?.trim();
  if (
    !stateDir ||
    !instanceId ||
    !isAbsolute(stateDir) ||
    !principalId ||
    !vaultRoot ||
    !isAbsolute(vaultRoot) ||
    !activeSessionRoot ||
    !isAbsolute(activeSessionRoot) ||
    !isAbsolute(resourceRoot) ||
    !["owner-and-household", "household", "none"].includes(memoryView ?? "")
  ) {
    throw new Error("Search runtime context is unavailable");
  }
  return {
    stateDir: resolve(stateDir),
    instanceId,
    principalId,
    memoryView: memoryView as SearchContext["memoryView"],
    vaultRoot: resolve(vaultRoot),
    sessionRoots: [resolve(activeSessionRoot)],
    resourceRoot: resolve(resourceRoot),
  };
}

function resultEnvelope(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: SearchToolDetails;
} {
  const details: SearchToolDetails = { ok: true, result, error: null };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function errorEnvelope(
  code = "SEARCH_UNAVAILABLE",
  message = "Search is temporarily unavailable",
): {
  content: Array<{ type: "text"; text: string }>;
  details: SearchToolDetails;
} {
  const details: SearchToolDetails = {
    ok: false,
    result: null,
    error: {
      code,
      message,
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

export type RefreshOutcome<T> =
  | { status: "fresh"; value: T }
  | { status: "timeout" }
  | { status: "failed" };

export async function settleRefreshWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<RefreshOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RefreshOutcome<T>>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ status: "timeout" }), timeoutMs);
  });
  const settled = promise.then<RefreshOutcome<T>, RefreshOutcome<T>>(
    (value) => ({ status: "fresh", value }),
    () => ({ status: "failed" }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default function searchExtension(pi: ExtensionAPI): void {
  let index: SearchIndex | undefined;
  const pendingRefreshes = new Set<Promise<unknown>>();
  const trackRefresh = <T>(promise: Promise<T>): Promise<T> => {
    pendingRefreshes.add(promise);
    void promise.then(
      () => pendingRefreshes.delete(promise),
      () => pendingRefreshes.delete(promise),
    );
    return promise;
  };
  const getIndex = (context: SearchContext): SearchIndex => {
    index ??= openSearchIndex({ stateDir: context.stateDir });
    return index;
  };
  const refreshMemory = async (activeIndex: SearchIndex, context: SearchContext) => {
    activeIndex.recordCorpusAttempt("memory", new Date().toISOString());
    const result = await rebuildMemoryIndex({
      index: activeIndex,
      vaultRoot: context.vaultRoot,
      resourceRoot: context.resourceRoot,
    });
    if (result.complete) activeIndex.recordCorpusSuccess("memory", new Date().toISOString());
    return result;
  };
  const refreshSessions = async (
    activeIndex: SearchIndex,
    context: SearchContext,
    rebuild = false,
  ) => {
    activeIndex.recordCorpusAttempt("session", new Date().toISOString());
    const result = await (rebuild ? rebuildSessionIndex : refreshSessionIndex)({
      index: activeIndex,
      roots: context.sessionRoots,
      instanceId: context.instanceId,
      principalId: context.principalId,
      includeSafeCwd: true,
    });
    if (result.complete) activeIndex.recordCorpusSuccess("session", new Date().toISOString());
    return result;
  };
  pi.on("session_start", () => {
    const activeIndex = index;
    index = undefined;
    void closeAfterPending(activeIndex);
  });
  pi.on("session_shutdown", () => {
    const activeIndex = index;
    index = undefined;
    void closeAfterPending(activeIndex);
  });

  async function closeAfterPending(activeIndex: SearchIndex | undefined): Promise<void> {
    await Promise.allSettled([...pendingRefreshes]);
    activeIndex?.close();
  }

  /** Fails closed: a stale index is not proof of current canonical visibility. */
  const requireFreshMemory = async (activeIndex: SearchIndex, context: SearchContext): Promise<void> => {
    const refresh = await settleRefreshWithin(
      trackRefresh(refreshMemory(activeIndex, context)),
      INTERACTIVE_REFRESH_BUDGET_MS,
    );
    if (refresh.status !== "fresh" || !refresh.value.complete) throw new Error("Memory index is not fresh");
  };

  // ADR-0037: the same refresh -> embed -> refresh privacy sequence as the
  // search tool, with one query per recent message in a single embedding batch.
  const retrieveRecallCandidates = async (
    context: SearchContext,
    queries: string[],
  ): Promise<RecallCandidate[]> => {
    const activeIndex = getIndex(context);
    const request = {
      query: queries[0]!,
      principal: context.principalId,
      memoryView: context.memoryView,
      limit: RECALL_CANDIDATE_LIMIT,
    };
    await requireFreshMemory(activeIndex, context);
    const semantic = await trackRefresh(
      prepareMemoryQueryEmbeddings(activeIndex, request, queries, createOpenAIEmbedder()),
    );
    if (semantic.status !== "disabled") await requireFreshMemory(activeIndex, context);
    return searchHybridMemoriesForQueries(activeIndex, request, queries, semantic)
      .map(({ id, revision, type, title, snippet }) => ({ id, revision, type, title, snippet }));
  };

  const currentRecallRevisions = async (context: SearchContext): Promise<Map<string, string>> => {
    const activeIndex = getIndex(context);
    await requireFreshMemory(activeIndex, context);
    return visibleMemoryRevisions(activeIndex, {
      query: "recall", principal: context.principalId, memoryView: context.memoryView,
    });
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (!isBridgeRuntime() || !isMemoryRecallEnabled() || !classifyRecallPrompt(event.prompt)) return;
    let context: SearchContext;
    try {
      context = resolveContext();
    } catch {
      return;
    }
    if (context.memoryView === "none") return;
    const message = await trackRefresh(recallMemories({
      prompt: event.prompt,
      entries: ctx.sessionManager.buildContextEntries(),
      sessionId: ctx.sessionManager.getSessionId(),
    }, {
      retrieve: (queries) => retrieveRecallCandidates(context, queries),
      currentRevisions: () => currentRecallRevisions(context),
      // Built per turn so it reads the current environment and global fetch.
      judge: createTypeSafeJudge({ timeoutMs: 3_000, maxAttempts: 1 }),
      log: (record) => appendRecallLog(context.stateDir, record),
    }));
    return message ? { message } : undefined;
  });

  pi.registerTool({
    name: "assistant_memory_search",
    label: "Search memories",
    description:
      "Search canonical personal-memory notes with keyword and, when configured, semantic retrieval. Returns stable note IDs, revisions, metadata, bounded snippets, and retrieval status.",
    promptSnippet: "Search durable personal memories",
    promptGuidelines: [
      "Use assistant_memory_search as the preferred memory retrieval path for saved facts and preferences. Use assistant_memory with the returned note ID for full reads and changes.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 512 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      types: Type.Optional(Type.Array(MemoryTypeSchema, { minItems: 1, maxItems: 7 })),
      statuses: Type.Optional(Type.Array(MemoryStatusSchema, { minItems: 1, maxItems: 3 })),
    }),
    async execute(_id, params) {
      // Track the whole pipeline so shutdown cannot close SQLite between
      // inference and the final canonical refresh/result serialization.
      return trackRefresh((async () => {
        try {
          const context = resolveContext();
          const activeIndex = getIndex(context);
          const request = {
            query: params.query,
            principal: context.principalId,
            memoryView: context.memoryView,
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            ...(params.types === undefined ? {} : { types: params.types }),
            ...(params.statuses === undefined ? {} : { statuses: params.statuses }),
          };
          let page = searchIndexedMemories(activeIndex, request);
          let refresh = await settleRefreshWithin(
            trackRefresh(refreshMemory(activeIndex, context)),
            INTERACTIVE_REFRESH_BUDGET_MS,
          );
          let semantic: MemoryEmbeddingPreparation = { status: "disabled" };
          if (refresh.status === "fresh" && refresh.value.complete) {
            semantic = await trackRefresh(prepareMemoryEmbeddings(activeIndex, request, createOpenAIEmbedder()));
            if (semantic.status !== "disabled") {
              // Network I/O opens a window for canonical edits, including privacy
              // changes. Revalidate before selecting or returning any result.
              refresh = await settleRefreshWithin(
                trackRefresh(refreshMemory(activeIndex, context)),
                INTERACTIVE_REFRESH_BUDGET_MS,
              );
            }
            page = refresh.status === "fresh" && refresh.value.complete
              ? searchHybridMemories(activeIndex, request, semantic)
              : { results: [], truncated: false };
          } else {
            // An old scope/owner is not proof of current canonical visibility.
            page = { results: [], truncated: false };
          }
          return resultEnvelope({
            ...page,
            retrieval: page.retrieval ?? { mode: "none", semantic: "skipped" },
            index:
              refresh.status === "fresh"
                ? { status: refresh.value.complete ? "fresh" : "partial", ...refresh.value }
                : {
                    status: "stale",
                    warning:
                      refresh.status === "timeout"
                        ? "refresh_timeout"
                        : "refresh_failed",
                    corpora: activeIndex.corpusStatuses(),
                  },
          });
        } catch (error) {
          return error instanceof SearchInputError
            ? errorEnvelope(error.code, error.message)
            : errorEnvelope();
        }
      })());
    },
  });

  pi.registerTool({
    name: "assistant_session_search",
    label: "Search sessions",
    description:
      "Search original Pi/Telegram session evidence through the isolated private FTS index. Returns stable session and entry anchors with bounded snippets.",
    promptSnippet: "Search prior conversation evidence",
    promptGuidelines: [
      "Use assistant_session_search when the user asks what was discussed, decided, attempted, or observed in earlier conversations. Present results as conversation history rather than saved memory, and keep the session ID, entry ID, and timestamp when citing them.",
      "Results include only user and assistant messages unless you pass roles to include tool results.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 512 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      roles: Type.Optional(Type.Array(SessionRoleSchema, { minItems: 1, maxItems: 3 })),
      from: Type.Optional(Type.String({ maxLength: 30 })),
      to: Type.Optional(Type.String({ maxLength: 30 })),
      project: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
    async execute(_id, params) {
      try {
        const context = resolveContext();
        const activeIndex = getIndex(context);
        const request = {
          query: params.query,
          instanceId: context.instanceId,
          principalId: context.principalId,
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          roles: params.roles ?? [...DEFAULT_SESSION_ROLES],
          ...(params.from === undefined ? {} : { from: params.from }),
          ...(params.to === undefined ? {} : { to: params.to }),
          ...(params.project === undefined ? {} : { project: params.project }),
        };
        let page = searchIndexedSessions(activeIndex, request);
        const refresh = await settleRefreshWithin(
          trackRefresh(refreshSessions(activeIndex, context)),
          INTERACTIVE_REFRESH_BUDGET_MS,
        );
        if (refresh.status === "fresh" && refresh.value.complete) {
          page = searchIndexedSessions(activeIndex, request);
        } else {
          page = { results: [], truncated: false };
        }
        return resultEnvelope({
          ...page,
          index:
            refresh.status === "fresh"
              ? { status: refresh.value.complete ? "fresh" : "partial", ...refresh.value }
              : {
                  status: "stale",
                  warning:
                    refresh.status === "timeout"
                      ? "refresh_timeout"
                      : "refresh_failed",
                  corpora: activeIndex.corpusStatuses(),
                },
        });
      } catch (error) {
        return error instanceof SearchInputError
          ? errorEnvelope(error.code, error.message)
          : errorEnvelope();
      }
    },
  });

  pi.registerTool({
    name: "session_context",
    label: "Read session context",
    description:
      "Read a bounded window around one session-search result. Use the session and entry IDs returned by assistant_session_search; this returns nearby turns, not the whole conversation.",
    promptSnippet: "Expand a session-search result with nearby turns",
    promptGuidelines: [
      "Use session_context with a returned sessionId and entryId when a search snippet lacks enough context; keep before/after counts small.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, maxLength: 256 }),
      entryId: Type.String({ minLength: 1, maxLength: 256 }),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 12_000 })),
    }),
    async execute(_id, params) {
      try {
        const context = resolveContext();
        const activeIndex = getIndex(context);
        const result = await readSessionContext(activeIndex, {
          sessionId: params.sessionId,
          entryId: params.entryId,
          instanceId: context.instanceId,
          principalId: context.principalId,
          roots: context.sessionRoots,
          ...(params.before === undefined ? {} : { before: params.before }),
          ...(params.after === undefined ? {} : { after: params.after }),
          ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
        });
        return resultEnvelope(result);
      } catch (error) {
        return error instanceof SearchInputError || error instanceof SessionContextError
          ? errorEnvelope(error.code, error.message)
          : errorEnvelope();
      }
    },
  });

  pi.registerTool({
    name: "search_index",
    label: "Manage search index",
    description:
      "Inspect, refresh, or rebuild the private derived memory/session search index. The canonical Markdown and JSONL sources are never modified.",
    promptSnippet: "Refresh or inspect derived search indexes",
    promptGuidelines: [
      "Use search_index only for explicit index maintenance or diagnosis; the search tools refresh themselves.",
    ],
    parameters: Type.Object({
      operation: OperationSchema,
      corpus: Type.Optional(CorpusSchema),
    }),
    async execute(_id, params) {
      return trackRefresh((async () => {
        try {
          const context = resolveContext();
          const activeIndex = getIndex(context);
          if (params.operation === "status") {
            return resultEnvelope({
              ...activeIndex.status(),
              corpora: activeIndex.corpusStatuses(),
            });
          }
          const corpus = params.corpus ?? "all";
          const result: Record<string, unknown> = {};
          if (corpus === "memory" || corpus === "all") {
            const memory = await trackRefresh(refreshMemory(activeIndex, context));
            result.memory = memory;
            if (memory.complete) {
              const semantic = await trackRefresh(prepareMemoryEmbeddings(activeIndex, {
                query: "memory", principal: context.principalId, memoryView: context.memoryView,
              }, createOpenAIEmbedder(), false));
              result.semantic = { status: semantic.status };
            }
          }
          if (corpus === "session" || corpus === "all") {
            result.session = await trackRefresh(refreshSessions(
              activeIndex,
              context,
              params.operation === "rebuild",
            ));
          }
          return resultEnvelope({
            ...result,
            status: {
              ...activeIndex.status(),
              corpora: activeIndex.corpusStatuses(),
            },
          });
        } catch (error) {
          return error instanceof SearchInputError
            ? errorEnvelope(error.code, error.message)
            : errorEnvelope();
        }
      })());
    },
  });
}
