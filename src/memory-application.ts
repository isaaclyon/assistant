import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { executeMemoryOperation } from "../.pi/skills/personal-memory/scripts/memory.mjs";
import { createMarkdownMemoryStore, MemoryError, validateMemoryDraft } from "../.pi/skills/personal-memory/scripts/store.mjs";
import { resolveMemoryDirectory, resolveMemoryView } from "../.pi/skills/personal-memory/scripts/config.mjs";
import { openSearchIndex, type MemoryDocumentSearchPage } from "./search-index.js";
import { rebuildMemoryIndex } from "./search-coordinator.js";
import { prepareMemoryEmbeddings, searchHybridMemories } from "./memory-semantic.js";
import { createOpenAIEmbedder } from "./openai-embeddings.js";
import { appendMemoryRead, type MemoryDecay } from "./memory-usage.js";

export interface MemoryDraft { type: string; title: string; tags?: string[]; body: string; decay?: MemoryDecay }
export interface MemoryPatch {
  title?: string; tags?: string[]; status?: string; decay?: MemoryDecay | null;
  bodyEdits?: Array<{ expectedText: string; replacementText: string }>;
}
export type MemoryConfirmationOperation = "delete" | "share";
interface Confirmation {
  operation: MemoryConfirmationOperation; id: string; revision: string;
  preview: { title: string; type: string; updated: string };
  expiresAt: number; chatId?: number;
}
interface Creation {
  draft: MemoryDraft; expiresAt: number;
  result?: Promise<Record<string, unknown>>;
}
const TTL_MS = 10 * 60_000;
function fail(code: string, message: string): never { throw new MemoryError(code, message); }

/** State belongs to one host-bound instance/session, never to model-supplied identity. */
export class MemoryApplication {
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly findDuplicates: (draft: MemoryDraft) => Promise<MemoryDocumentSearchPage>;
  private readonly creations = new Map<string, Creation>();
  private readonly confirmations = new Map<string, Confirmation>();

  constructor(options: {
    env: NodeJS.ProcessEnv; cwd?: string; now?: () => number;
    findDuplicates?: (draft: MemoryDraft) => Promise<MemoryDocumentSearchPage>;
  }) {
    this.env = { ...options.env };
    this.cwd = options.cwd ?? process.cwd();
    this.now = options.now ?? Date.now;
    if (!this.env.PI_TELEGRAM_PRINCIPAL || !this.env.PI_TELEGRAM_MEMORY_VIEW ||
        !this.env.PI_TELEGRAM_BRIDGE_STATE_DIR || !isAbsolute(this.env.PI_TELEGRAM_BRIDGE_STATE_DIR) ||
        resolveMemoryView(this.env).memoryView === "none") {
      fail("UNAVAILABLE", "Memory tools require a configured personal or household instance");
    }
    this.findDuplicates = options.findDuplicates ?? (draft => this.searchDuplicates(draft));
  }

  private run(command: string, request: Record<string, unknown>, confirmed = false) {
    return executeMemoryOperation(command, request, { env: this.env, cwd: this.cwd, confirmed });
  }

  /** An agent read; also a usage signal for ranking (ADR-0045). */
  async read(id: string) {
    const note = await this.run("read", { id });
    // Usage is a ranking hint; a failed log write never fails the read.
    await appendMemoryRead(this.env.PI_TELEGRAM_BRIDGE_STATE_DIR!, String(note.id), new Date(this.now()))
      .catch(() => undefined);
    return note;
  }

  private prune<T extends { expiresAt: number }>(map: Map<string, T>) {
    for (const [token, item] of map) if (item.expiresAt <= this.now()) map.delete(token);
    if (map.size >= 32) map.delete(map.keys().next().value!);
  }

  async prepareCreate(request: MemoryDraft) {
    if (!request || Object.keys(request).some(key => !["type", "title", "tags", "body", "decay"].includes(key))) {
      fail("INVALID_INPUT", "Memory draft is invalid");
    }
    const draft = validateMemoryDraft(request) as MemoryDraft;
    const page = await this.findDuplicates(draft);
    this.prune(this.creations);
    const creationToken = randomUUID();
    this.creations.set(creationToken, { draft: structuredClone(draft), expiresAt: this.now() + TTL_MS });
    return { creationToken, possibleDuplicates: page.results, retrieval: page.retrieval ?? { mode: "keyword" },
      instruction: "Compare these related notes. Update an existing note if it covers the same fact; otherwise create using this token. Ask if materially ambiguous." };
  }

  async create(creationToken: string): Promise<Record<string, unknown>> {
    const creation = this.creations.get(creationToken);
    if (!creation || creation.expiresAt <= this.now()) fail("STALE_ACTION", "Prepare the memory again before creating it");
    // The same token shares both an in-flight write and its settled result.
    // Failed writes also remain settled: a fresh preparation is the safe retry.
    creation.result ??= this.run("add", { ...creation.draft });
    return creation.result;
  }

  update(id: string, ifRevision: string, patch: MemoryPatch) {
    if (!patch || Object.keys(patch).length === 0 ||
        Object.keys(patch).some(key => !["title", "tags", "status", "decay", "bodyEdits"].includes(key))) {
      fail("INVALID_INPUT", "Use targeted text edits or metadata changes; sharing requires confirmation");
    }
    return this.run("update", { id, ifRevision, patch });
  }

  async requestConfirmation(operation: MemoryConfirmationOperation, id: string, revision: string) {
    if (operation !== "delete" && operation !== "share") fail("INVALID_INPUT", "Unknown memory operation");
    const note = await this.run("read", { id });
    if (note.revision !== revision) fail("REVISION_CONFLICT", "Memory changed since it was read");
    if (operation === "share" && note.scope !== "personal") fail("INVALID_INPUT", "This note is already household-visible");
    this.prune(this.confirmations);
    const token = randomUUID();
    const preview = { title: String(note.title), type: String(note.type), updated: String(note.updated) };
    this.confirmations.set(token, { operation, id, revision, preview, expiresAt: this.now() + TTL_MS });
    return { token, operation, id, preview };
  }

  bindConfirmation(token: string, chatId: number): void {
    const item = this.confirmations.get(token);
    if (!item || item.expiresAt <= this.now() || (item.chatId !== undefined && item.chatId !== chatId)) {
      fail("STALE_ACTION", "Request a fresh memory confirmation");
    }
    item.chatId = chatId;
  }

  private takeConfirmation(token: string, chatId: number) {
    const item = this.confirmations.get(token);
    if (!item || item.expiresAt <= this.now() || item.chatId !== chatId) fail("STALE_ACTION", "That confirmation is unavailable or expired");
    this.confirmations.delete(token);
    return item;
  }

  /** Only an authorized Telegram section callback calls this; no tool accepts an approval token. */
  async confirm(token: string, chatId: number) {
    const item = this.takeConfirmation(token, chatId);
    return item.operation === "delete"
      ? this.run("delete", { id: item.id, ifRevision: item.revision, confirmId: item.id }, true)
      : this.run("update", { id: item.id, ifRevision: item.revision, patch: { scope: "household" } }, true);
  }

  cancel(token: string, chatId: number) { this.takeConfirmation(token, chatId); }
  discard(token: string) { this.confirmations.delete(token); }
  clear() { this.creations.clear(); this.confirmations.clear(); }

  private async searchDuplicates(draft: MemoryDraft): Promise<MemoryDocumentSearchPage> {
    const index = openSearchIndex({ stateDir: this.env.PI_TELEGRAM_BRIDGE_STATE_DIR! });
    const resourceRoot = this.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT ?? this.cwd;
    const request = { ...resolveMemoryView(this.env), query: `${draft.title}\n${draft.body}`.slice(0, 512), limit: 5 };
    const refresh = async () => {
      const result = await rebuildMemoryIndex({ index, resourceRoot, vaultRoot: resolveMemoryDirectory(this.env) });
      if (!result.complete) fail("SEARCH_UNAVAILABLE", "Duplicate search could not verify current memories; retry preparation");
    };
    try {
      const store = createMarkdownMemoryStore({ root: resolveMemoryDirectory(this.env),
        forbiddenRoots: [this.cwd, resourceRoot], ...resolveMemoryView(this.env) });
      if (!(await store.verifyRoot()) && index.status().memoryDocuments === 0) {
        // First-ever creation needs an empty, verified vault to search. A
        // missing vault with indexed notes still fails closed below.
        await store.withMutation(async () => undefined);
      }
      await refresh();
      const prepared = await prepareMemoryEmbeddings(index, request, createOpenAIEmbedder({ env: this.env }));
      if (prepared.status !== "disabled") await refresh();
      return searchHybridMemories(index, request, prepared);
    } finally { index.close(); }
  }
}
