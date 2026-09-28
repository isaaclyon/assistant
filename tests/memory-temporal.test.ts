import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openSearchIndex, type MemoryIndexDocument } from "../src/search-index.js";
import { mergeTemporalCandidates, searchTemporalMemories } from "../src/memory-temporal.js";

const note = (id: string, patch: Partial<MemoryIndexDocument> = {}): MemoryIndexDocument => ({
  noteId: id, relativePath: `${id}.md`, revision: "r1", title: "Austin City Limits", tags: [],
  body: "Going to ACL in Austin, 2026-10-02 to 2026-10-04. Outdoors all day.", type: "event",
  status: "active", scope: "personal", owner: "alice", createdAt: "2026-10-03", updatedAt: "2026-10-03", ...patch,
});

it("finds overlapping event intervals with no keyword match, using only visible active note content", async () => {
  const root = await mkdtemp(join(tmpdir(), "temporal-memory-"));
  const index = openSearchIndex({ stateDir: root });
  try {
    index.replaceMemoryDocuments([
      note("acl"), note("foreign", { owner: "bob" }), note("archived", { status: "archived" }),
      note("superseded", { status: "superseded" }),
      note("old-trip", { body: "ACL: October 2-4, 2025" }),
      note("long-trip", { body: "Travel: 2026-09-28 through 2026-10-10" }),
      note("shared", { scope: "household", owner: null, body: "2026-10-03: We will feed the cat." }),
      note("relative", { body: "ACL next weekend" }),
      note("created-only", { body: "Prefers warm weather." }),
      note("source-only", { body: "Likes music.\n[^s1]: session:2026-10-03 source evidence" }),
    ]);
    const request = { query: "what should I pack", principal: "alice", memoryView: "owner-and-household" as const };
    const ranges = [{ text: "Saturday", start: "2026-10-03", end: "2026-10-03" }];
    const results = searchTemporalMemories(index, request, ranges);
    expect(results.map((result) => result.id).sort()).toEqual(["acl", "long-trip", "shared"]);
    expect(results.find((result) => result.id === "acl")?.snippet).toContain("2026-10-02 through 2026-10-04");
    expect(searchTemporalMemories(index, { ...request, memoryView: "none" }, ranges)).toEqual([]);
    expect(searchTemporalMemories(index, { ...request, memoryView: "household" }, ranges).map((result) => result.id)).toEqual(["shared"]);
    index.replaceMemoryDocuments([note("acl", { owner: "bob", revision: "r2" })]);
    expect(searchTemporalMemories(index, request, ranges)).toEqual([]);
  } finally { index.close(); await rm(root, { recursive: true, force: true }); }
});

it("keeps date matches in a full recall candidate list without crowding out content matches", () => {
  const content = Array.from({ length: 8 }, (_, i) => ({ id: `content-${i}` }));
  const temporal = [{ id: "acl" }, { id: "content-0" }];
  const merged = mergeTemporalCandidates(content, temporal, 8);
  expect(merged.map((item) => item.id)).toEqual(["acl", ...content.slice(0, 7).map((item) => item.id)]);
});
