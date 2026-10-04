import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { openSearchIndex, type MemoryIndexDocument, type SearchIndex } from "../src/search-index.js";
import {
  prepareMemoryEmbeddings,
  prepareMemoryQueryEmbeddings,
  searchHybridMemories,
  searchHybridMemoriesForQueries,
  visibleMemoryRevisions,
} from "../src/memory-semantic.js";
import { EMBEDDING_DIMENSIONS } from "../src/openai-embeddings.js";

const roots: string[] = [];
const indexes: SearchIndex[] = [];
afterEach(async () => {
  indexes.splice(0).forEach((index) => index.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const request = { query: "somewhere we can hear each other", principal: "alice", memoryView: "owner-and-household" as const };
const note = (id: string, patch: Partial<MemoryIndexDocument> = {}): MemoryIndexDocument => ({
  noteId: id, relativePath: `${id}.md`, revision: "r1", title: "Dining", tags: [],
  body: "Prefers quiet restaurants", type: "preference", status: "active", scope: "personal", owner: "alice",
  createdAt: "2026-01-01", updatedAt: "2026-01-01", ...patch,
});
const vector = (axis = 0) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === axis ? 1 : 0);
async function setup(documents: MemoryIndexDocument[]) {
  const root = await mkdtemp(join(tmpdir(), "semantic-memory-"));
  roots.push(root);
  const index = openSearchIndex({ stateDir: root });
  indexes.push(index);
  index.replaceMemoryDocuments(documents);
  return index;
}

it("finds a paraphrase, caches unchanged notes across refresh/reopen, and retains provenance", async () => {
  const index = await setup([note("quiet")]);
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => vector()));
  const prepared = await prepareMemoryEmbeddings(index, request, embed);
  const page = searchHybridMemories(index, request, prepared);
  expect(page.results).toHaveLength(1);
  expect(page.results[0]).toMatchObject({ id: "quiet", revision: "r1", source: "memory", snippet: expect.stringContaining("quiet") });
  expect(prepared.status).toBe("ready");
  expect(embed.mock.calls[0]![0]).toHaveLength(2);
  index.replaceMemoryDocuments([note("quiet")]);
  const reopened = openSearchIndex({ stateDir: roots[0]! });
  indexes.push(reopened);
  await prepareMemoryEmbeddings(reopened, request, embed);
  expect(embed.mock.calls[1]![0]).toEqual([request.query]);
});

it("filters owner, scope, status and type before sending any note to OpenAI", async () => {
  const index = await setup([
    note("own"), note("foreign", { owner: "bob", body: "foreign-secret" }),
    note("shared", { scope: "household", owner: null }),
    note("old", { status: "archived", body: "archived-secret" }),
    note("person", { type: "person", body: "person-secret" }),
  ]);
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => vector()));
  const filtered = { ...request, types: ["preference"] };
  const prepared = await prepareMemoryEmbeddings(index, filtered, embed);
  expect(JSON.stringify(embed.mock.calls)).not.toMatch(/foreign-secret|archived-secret|person-secret/);
  expect(searchHybridMemories(index, filtered, prepared).results.map((r) => r.id).sort()).toEqual(["own", "shared"]);
  const household = { ...filtered, memoryView: "household" as const };
  expect(searchHybridMemories(index, household, prepared).results.map((r) => r.id)).toEqual(["shared"]);
  await prepareMemoryEmbeddings(index, { ...request, memoryView: "none" }, embed);
  expect(embed).toHaveBeenCalledTimes(1);
});

it("drops changed/deleted/re-scoped notes even when they change during inference", async () => {
  const index = await setup([note("quiet")]);
  const embed = async (inputs: string[]) => {
    index.replaceMemoryDocuments([note("quiet", { revision: "r2", owner: "bob" })]);
    return inputs.map(() => vector());
  };
  const prepared = await prepareMemoryEmbeddings(index, request, embed);
  expect(searchHybridMemories(index, request, prepared).results).toEqual([]);
  index.replaceMemoryDocuments([]);
  expect(index.semantic.chunks(request)).toEqual([]);
});

it("migrates schema 2, re-embeds edits, and removes deleted vectors", async () => {
  const index = await setup([note("quiet")]);
  index.close();
  indexes.pop();
  const path = join(roots[0]!, "search-index.db");
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE memory_embedding; UPDATE search_index_metadata SET schema_version = 2");
  legacy.close();
  const migrated = openSearchIndex({ stateDir: roots[0]! });
  indexes.push(migrated);
  expect(migrated.status()).toMatchObject({ schemaVersion: 4, memoryDocuments: 1 });
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => vector()));
  await prepareMemoryEmbeddings(migrated, request, embed);
  migrated.replaceMemoryDocuments([note("quiet", { revision: "r2", body: "Enjoys lively dining" })]);
  await prepareMemoryEmbeddings(migrated, request, embed);
  expect(embed.mock.calls[1]![0]).toHaveLength(2);
  expect(embed.mock.calls[1]![0][1]).toContain("lively");
  migrated.replaceMemoryDocuments([]);
  const db = new DatabaseSync(path);
  expect(db.prepare("SELECT count(*) AS n FROM memory_embedding").get()!.n).toBe(0);
  db.close();
});

it("warms the cache during maintenance without sending a query or re-embedding unchanged notes", async () => {
  const index = await setup([note("quiet")]);
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => vector()));
  expect(await prepareMemoryEmbeddings(index, request, embed, false)).toEqual({ status: "ready" });
  expect(embed.mock.calls[0]![0]).toHaveLength(1);
  expect(embed.mock.calls[0]![0][0]).toContain("quiet restaurants");
  await prepareMemoryEmbeddings(index, request, embed, false);
  expect(embed).toHaveBeenCalledTimes(1);
});

it("bounds cold indexing and resumes missing chunks without re-embedding completed ones", async () => {
  const index = await setup(Array.from({ length: 35 }, (_, i) => note(String(i))));
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => vector()));
  expect((await prepareMemoryEmbeddings(index, request, embed)).status).toBe("partial");
  expect(embed.mock.calls[0]![0]).toHaveLength(33);
  expect((await prepareMemoryEmbeddings(index, request, embed)).status).toBe("ready");
  expect(embed.mock.calls[1]![0]).toHaveLength(4);
});

it("chunks long Unicode notes without losing the tail and returns its matching section", async () => {
  const index = await setup([note("long", { body: `${"🦊".repeat(4000)}\n\n## Dining\nPrefers quiet restaurants` })]);
  const embed = async (inputs: string[]) => inputs.map((text, i) => vector(i === 0 || text.includes("quiet") ? 0 : 1));
  const prepared = await prepareMemoryEmbeddings(index, request, embed);
  const chunks = index.semantic.chunks(request);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => Buffer.byteLength(chunk.input) <= 6000 && !chunk.input.includes("�"))).toBe(true);
  expect(searchHybridMemories(index, request, prepared).results[0]!.snippet).toContain("quiet");
});

it("preserves keyword results and reports a bounded fallback on API failure", async () => {
  const index = await setup([note("quiet")]);
  const query = { ...request, query: "quiet" };
  const prepared = await prepareMemoryEmbeddings(index, query, async () => { throw new Error("secret key payload"); });
  expect(prepared).toEqual({ status: "unavailable" });
  expect(searchHybridMemories(index, query, prepared).results.map((r) => r.id)).toEqual(["quiet"]);
});

it("combines lexical and semantic ranks, deduplicates notes, and honors the limit", async () => {
  const index = await setup([note("both"), note("semantic", { body: "Low noise dining" }), note("keyword", { body: "quiet appliance" })]);
  const query = { ...request, query: "quiet", limit: 2 };
  const embed = async (inputs: string[]) => inputs.map((text) => vector(text.includes("appliance") ? 1 : 0));
  const prepared = await prepareMemoryEmbeddings(index, query, embed);
  const page = searchHybridMemories(index, query, prepared);
  expect(page.results[0]!.id).toBe("both");
  expect(page.results).toHaveLength(2);
  expect(new Set(page.results.map((r) => r.id)).size).toBe(2);
  expect(page.truncated).toBe(true);
});

it("embeds several queries in one bounded request and keeps each query's best match", async () => {
  const documents = Array.from({ length: 40 }, (_, i) => note(`n${String(i).padStart(2, "0")}`, {
    title: `Note ${i}`, body: i === 7 ? "Emma is allergic to shellfish" : `Filler ${i}`,
  }));
  documents.push(note("dinner", { title: "Kin Khao", body: "Favorite Thai restaurant for Friday dinners" }));
  const index = await setup(documents);
  // Axis 1 marks the allergy note and the first query; axis 2 the restaurant and the third.
  const embed = vi.fn(async (inputs: string[]) => inputs.map((input) =>
    vector(/shellfish|seafood allergy/.test(input) ? 1 : /Kin Khao|Thai/.test(input) ? 2 : 0)));
  const queries = ["any seafood allergy concerns", "ok do it", "book Thai for Friday"];
  const prepared = await prepareMemoryQueryEmbeddings(index, { ...request, query: queries[0]! }, queries, embed);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(embed.mock.calls[0]![0]).toHaveLength(33);
  expect(embed.mock.calls[0]![0].slice(0, 3)).toEqual(queries);
  expect(prepared).toMatchObject({ status: "partial", queryVectors: [expect.any(Array), expect.any(Array), expect.any(Array)] });
  await prepareMemoryQueryEmbeddings(index, { ...request, query: queries[0]! }, queries, embed);
  const again = await prepareMemoryQueryEmbeddings(index, { ...request, query: queries[0]! }, queries, embed);
  expect(again.status).toBe("ready");
  const ids = searchHybridMemoriesForQueries(index, { ...request, query: queries[0]!, limit: 8 }, queries, again)
    .map((result) => result.id);
  expect(ids).toHaveLength(8);
  // The uninformative middle query ranks fillers first; interleaving still keeps both real matches on top.
  expect(ids.slice(0, 3)).toEqual(["n07", "n00", "dinner"]);
  expect(visibleMemoryRevisions(index, request).get("dinner")).toBe("r1");
  await expect(prepareMemoryQueryEmbeddings(index, request, ["a", "b", "c", "d"], embed)).rejects.toThrow(/Too many/);
});
