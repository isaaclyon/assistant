import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMemoryRanking,
  createMemoryUsageTally,
  decayDrop,
  rankWithDrops,
  type MemoryRanking,
  type RankableNote,
} from "../src/memory-usage.js";
import { openSearchIndex, type MemoryIndexDocument, type SearchIndex } from "../src/search-index.js";
import { searchHybridMemories } from "../src/memory-semantic.js";
import { EMBEDDING_DIMENSIONS } from "../src/openai-embeddings.js";
import { MemoryApplication } from "../src/memory-application.js";
import { rebuildMemoryIndex } from "../src/search-coordinator.js";
import { createMarkdownMemoryStore } from "../.pi/skills/personal-memory/scripts/store.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const note = (patch: Partial<RankableNote> = {}): RankableNote => ({
  id: "n", type: "list", created: ago(300), updated: ago(300), ...patch,
});

const roots: string[] = [];
const indexes: SearchIndex[] = [];
afterEach(async () => {
  indexes.splice(0).forEach((index) => index.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-usage-"));
  roots.push(root);
  return root;
}

describe("decayDrop", () => {
  it("never moves durable types and fades unused lists, events, and purchases", () => {
    for (const type of ["person", "preference", "recipe", "reference", "unknown"]) {
      expect(decayDrop(note({ type }), undefined, [], NOW)).toBe(0);
    }
    for (const type of ["list", "event", "purchase"]) {
      expect(decayDrop(note({ type }), undefined, [], NOW)).toBe(3);
    }
  });

  it("keeps a new fading note in place for 30 days, then lets it drift down", () => {
    const unused = (days: number) => decayDrop(note({ created: ago(days), updated: ago(days) }), undefined, [], NOW);
    expect([29, 31, 90, 240].map(unused)).toEqual([0, 1, 2, 3]);
  });

  it("lets the decay header override the type default in both directions", () => {
    expect(decayDrop(note({ type: "reference" }), "fading", [], NOW)).toBe(3);
    expect(decayDrop(note({ type: "list" }), "durable", [], NOW)).toBe(0);
  });

  it("restores rank with recent reads and edits, and lets old use fade", () => {
    expect(decayDrop(note(), undefined, [{ at: NOW - 10 * DAY, points: 3 }], NOW)).toBe(0);
    expect(decayDrop(note({ updated: ago(10) }), undefined, [], NOW)).toBe(0);
    // A read 90 days ago (1.5 points) plus a 300-day-old edit (0.3 points).
    expect(decayDrop(note(), undefined, [{ at: NOW - 90 * DAY, points: 3 }], NOW)).toBe(1);
    // Repeated injections alone add up to a meaningful score.
    const injections = Array.from({ length: 3 }, () => ({ at: NOW - DAY, points: 1 }));
    expect(decayDrop(note(), undefined, injections, NOW)).toBe(0);
  });
});

describe("rankWithDrops", () => {
  const drops = (values: Record<string, number>): MemoryRanking => ({ drop: (n) => values[n.id] ?? 0 });
  const notes = (...ids: string[]) => ids.map((id) => note({ id }));

  it("moves a fully faded first result exactly three places down", () => {
    const ranked = rankWithDrops(notes("a", "b", "c", "d", "e"), drops({ a: 3 }));
    expect(ranked.map((n) => n.id)).toEqual(["b", "c", "d", "a", "e"]);
  });

  it("keeps order unchanged without drops", () => {
    expect(rankWithDrops(notes("a", "b", "c"), drops({})).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});

describe("createMemoryUsageTally", () => {
  it("reads injections and agent reads, then only appended lines", async () => {
    const stateDir = await tempDir();
    const recall = join(stateDir, "memory-recall.jsonl");
    await writeFile(recall, `${JSON.stringify({ at: ago(1), candidates: [
      { id: "a", result: "injected" }, { id: "b", result: "below_threshold" },
    ] })}\nnot json\n`);
    await writeFile(join(stateDir, "memory-usage.jsonl"), `${JSON.stringify({ at: ago(2), event: "read", id: "a" })}\n`);
    const tally = createMemoryUsageTally(stateDir);
    await tally.refresh();
    expect(tally.events("a").map((e) => e.points).sort()).toEqual([1, 3]);
    expect(tally.events("b")).toEqual([]);

    // A partially written line waits for its newline.
    const line = JSON.stringify({ at: ago(0), candidates: [{ id: "b", result: "injected" }] });
    await appendFile(recall, line.slice(0, 10));
    await tally.refresh();
    expect(tally.events("b")).toEqual([]);
    await appendFile(recall, `${line.slice(10)}\n`);
    await tally.refresh();
    expect(tally.events("b")).toHaveLength(1);
    expect(tally.events("a")).toHaveLength(2);
  });

  it("treats missing logs as no usage and rejects unreadable logs", async () => {
    const stateDir = await tempDir();
    const tally = createMemoryUsageTally(stateDir);
    await tally.refresh();
    expect(tally.events("a")).toEqual([]);
    await mkdir(join(stateDir, "memory-usage.jsonl"));
    await expect(tally.refresh()).rejects.toThrow();
  });
});

describe("usage-ranked search", () => {
  const request = { query: "groceries", principal: "alice", memoryView: "owner-and-household" as const };
  const doc = (id: string, patch: Partial<MemoryIndexDocument> = {}): MemoryIndexDocument => ({
    noteId: id, relativePath: `${id}.md`, revision: "r1", title: "Groceries", tags: [], body: "Groceries to buy",
    type: "list", status: "active", scope: "personal", owner: "alice",
    createdAt: ago(200), updatedAt: ago(200), ...patch,
  });
  async function setup(stateDir: string, documents: MemoryIndexDocument[]) {
    const index = openSearchIndex({ stateDir });
    indexes.push(index);
    index.replaceMemoryDocuments(documents);
    return index;
  }
  async function ranking(stateDir: string, index: SearchIndex) {
    const usage = createMemoryUsageTally(stateDir);
    await usage.refresh();
    return createMemoryRanking({ usage, overrides: index.memoryDecayOverrides(), now: NOW });
  }

  it("ranks an unused faded list below an equally matched, recently read one", async () => {
    const stateDir = await tempDir();
    // "a" wins the id tie-break, so without ranking it comes first.
    const index = await setup(stateDir, [doc("a"), doc("b")]);
    await writeFile(join(stateDir, "memory-usage.jsonl"), `${JSON.stringify({ at: ago(3), event: "read", id: "b" })}\n`);
    const keyword = { status: "disabled" as const };
    expect(searchHybridMemories(index, request, keyword).results.map((r) => r.id)).toEqual(["a", "b"]);
    const ranked = await ranking(stateDir, index);
    expect(searchHybridMemories(index, request, keyword, ranked).results.map((r) => r.id)).toEqual(["b", "a"]);
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
    for (const chunk of index.semantic.chunks(request)) index.semantic.save(chunk, vector);
    const hybrid = { status: "ready" as const, queryVector: vector };
    expect(searchHybridMemories(index, request, hybrid, ranked).results.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("indexes the decay header from canonical notes", async () => {
    const root = await tempDir();
    const store = createMarkdownMemoryStore({ root: join(root, "vault"), forbiddenRoots: [process.cwd()] });
    const fading = await store.add({ type: "reference", title: "Pi extensions", body: "npm", decay: "fading" });
    await store.add({ type: "list", title: "Plain", body: "" });
    const index = await setup(join(root, "state"), []);
    expect((await rebuildMemoryIndex({ index, vaultRoot: join(root, "vault"), resourceRoot: process.cwd() })).complete).toBe(true);
    expect(index.memoryDecayOverrides()).toEqual(new Map([[fading.id, "fading"]]));
  });

  it("reads decay overrides from the index and keeps usage across an index rebuild", async () => {
    const stateDir = await tempDir();
    const index = await setup(stateDir, [doc("a", { decay: "durable" }), doc("b"), doc("c", { type: "person" })]);
    expect(index.memoryDecayOverrides()).toEqual(new Map([["a", "durable"]]));
    await writeFile(join(stateDir, "memory-usage.jsonl"), `${JSON.stringify({ at: ago(1), event: "read", id: "b" })}\n`);
    index.close();
    indexes.pop();
    await rm(join(stateDir, "search-index.db"));
    const rebuilt = await setup(stateDir, [doc("a"), doc("b")]);
    const ranked = await ranking(stateDir, rebuilt);
    expect(ranked.drop({ id: "b", type: "list", created: ago(200), updated: ago(200) })).toBe(0);
  });
});

describe("agent reads", () => {
  it("logs an agent read by ID without changing the note", async () => {
    const root = await tempDir();
    const env = { PI_TELEGRAM_MEMORY_DIR: join(root, "vault"), PI_TELEGRAM_BRIDGE_STATE_DIR: join(root, "state"),
      PI_TELEGRAM_PRINCIPAL: "isaac", PI_TELEGRAM_MEMORY_VIEW: "owner-and-household" };
    await mkdir(env.PI_TELEGRAM_BRIDGE_STATE_DIR, { recursive: true });
    const app = new MemoryApplication({ env, findDuplicates: async () => ({ results: [], truncated: false }), now: () => NOW });
    const draft = await app.prepareCreate({ type: "list", title: "Gift ideas", body: "A book.", decay: "durable" });
    const created = await app.create(draft.creationToken);
    const path = join(env.PI_TELEGRAM_MEMORY_DIR, "lists", `${String(created.id)}.md`);
    const before = await readFile(path, "utf8");
    const read = await app.read(String(created.id));
    expect(read.decay).toBe("durable");
    expect(read.revision).toBe(created.revision);
    expect(await readFile(path, "utf8")).toBe(before);
    const log = (await readFile(join(env.PI_TELEGRAM_BRIDGE_STATE_DIR, "memory-usage.jsonl"), "utf8")).trim().split("\n");
    expect(log.map((line) => JSON.parse(line))).toEqual([{ at: new Date(NOW).toISOString(), event: "read", id: created.id }]);
  });
});
