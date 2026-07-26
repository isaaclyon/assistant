import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openSearchIndex, type SearchIndex } from "../src/search-index.js";

describe("search index foundation", () => {
  const indexes: SearchIndex[] = [];

  afterEach(() => {
    for (const index of indexes.splice(0)) index.close();
  });

  it("creates a private versioned index with separate corpora", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const stateDir = join(root, "instances", "isaac");
    const index = openSearchIndex({ stateDir });
    indexes.push(index);

    expect(index.status()).toEqual({
      schemaVersion: 1,
      memoryDocuments: 0,
      sessionDocuments: 0,
    });
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, "search-index.db"))).mode & 0o777).toBe(0o600);
  });

  it("transactionally replaces memory rows and keeps FTS matches synchronized", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);

    index.replaceMemoryDocuments([
      {
        noteId: "note-1",
        relativePath: "note-1.md",
        revision: "rev-1",
        title: "Coffee preferences",
        tags: ["drinks", "household"],
        body: "Isaac likes a light roast.",
        type: "preference",
        status: "active",
        scope: "personal",
        owner: "isaac",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(index.searchMemory("coffee", 10).results.map((result) => result.noteId)).toEqual([
      "note-1",
    ]);

    index.replaceMemoryDocuments([]);

    expect(index.searchMemory("coffee", 10).results).toEqual([]);
    expect(index.status().memoryDocuments).toBe(0);
  });

  it("falls back from invalid FTS syntax and reports bounded truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);
    const common = {
      revision: "rev-1",
      title: "Coffee",
      tags: ["drink"],
      body: "Coffee notes",
      type: "reference",
      status: "active",
      scope: "household",
      owner: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    index.replaceMemoryDocuments([
      { ...common, noteId: "note-b", relativePath: "b.md" },
      { ...common, noteId: "note-a", relativePath: "a.md" },
    ]);

    expect(index.searchMemory("coffee OR", 1)).toMatchObject({
      results: [{ noteId: "note-a" }],
      truncated: true,
      warning: "invalid_fts_query_fallback",
    });
  });

  it("preserves the previous usable corpus when replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);
    const original = {
      noteId: "original",
      relativePath: "original.md",
      revision: "rev-1",
      title: "Original memory",
      tags: ["stable"],
      body: "Known good content",
      type: "reference",
      status: "active",
      scope: "household",
      owner: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    index.replaceMemoryDocuments([original]);

    expect(() =>
      index.replaceMemoryDocuments([
        { ...original, noteId: "duplicate-a", relativePath: "duplicate.md" },
        { ...original, noteId: "duplicate-b", relativePath: "duplicate.md" },
      ]),
    ).toThrow();

    expect(index.searchMemory("original", 10).results.map((result) => result.noteId)).toEqual([
      "original",
    ]);
  });

  it("replaces and searches session rows with stable provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);

    index.replaceSessionDocuments([
      {
        instanceId: "isaac",
        principalId: "isaac",
        sessionId: "session-1",
        entryId: "entry-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "user",
        project: "assistant",
        cwd: null,
        sourcePath: "session-1.jsonl",
        sourceOffset: 42,
        searchableText: "Discuss the rebuildable search index",
      },
    ]);

    expect(index.searchSessions("rebuildable", 10)).toMatchObject({
      results: [
        {
          instanceId: "isaac",
          sessionId: "session-1",
          entryId: "entry-1",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      truncated: false,
    });
  });

  it("fails closed on an unsupported schema version without exposing indexed text", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const stateDir = join(root, "state");
    const index = openSearchIndex({ stateDir });
    index.close();
    const databasePath = join(stateDir, "search-index.db");
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE search_index_metadata SET schema_version = 999 WHERE singleton = 1").run();
    db.close();

    expect(() => openSearchIndex({ stateDir })).toThrow(
      "Search index schema version 999 is not supported",
    );
  });

  it("normalizes non-finite search limits before binding them to SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);
    index.replaceMemoryDocuments([
      {
        noteId: "finite",
        relativePath: "finite.md",
        revision: "rev-1",
        title: "Finite bounds",
        tags: [],
        body: "Bound every query",
        type: "reference",
        status: "active",
        scope: "household",
        owner: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(index.searchMemory("finite", Number.POSITIVE_INFINITY).results).toHaveLength(1);
    expect(index.searchMemory("finite", Number.NaN).results).toHaveLength(1);
  });

  it("supports quoted Unicode phrases and concise snippets", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);
    index.replaceMemoryDocuments([
      {
        noteId: "unicode",
        relativePath: "unicode.md",
        revision: "rev-1",
        title: "Café notes",
        tags: ["méxico"],
        body: "The exact phrase is café tranquilo near the plaza.",
        type: "reference",
        status: "active",
        scope: "household",
        owner: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(index.searchMemory('"café tranquilo"', 10)).toMatchObject({
      results: [{ noteId: "unicode", snippet: expect.stringContaining("café tranquilo") }],
      truncated: false,
    });
  });

  it("persists separate last-attempt and last-success status for each corpus", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const stateDir = join(root, "state");
    const index = openSearchIndex({ stateDir });
    index.recordCorpusAttempt("memory", "2026-07-25T12:00:00.000Z");
    index.recordCorpusSuccess("memory", "2026-07-25T12:00:01.000Z");
    index.recordCorpusAttempt("session", "2026-07-25T12:00:02.000Z");
    index.close();

    const reopened = openSearchIndex({ stateDir });
    indexes.push(reopened);
    expect(reopened.corpusStatuses()).toEqual({
      memory: {
        lastAttemptAt: "2026-07-25T12:00:00.000Z",
        lastSuccessAt: "2026-07-25T12:00:01.000Z",
      },
      session: {
        lastAttemptAt: "2026-07-25T12:00:02.000Z",
        lastSuccessAt: null,
      },
    });
  });

  it("bounds snippets by characters even when one FTS token is enormous", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);
    index.replaceSessionDocuments([
      {
        instanceId: "isaac",
        principalId: "isaac",
        sessionId: "session-long",
        entryId: "entry-long",
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "toolResult",
        project: null,
        cwd: null,
        sourcePath: "session-long.jsonl",
        sourceOffset: 1,
        searchableText: `needle${"x".repeat(2_000)}`,
      },
    ]);

    const page = index.searchSessionDocuments({
      query: "needle*",
      limit: 10,
      instanceId: "isaac",
      principalId: "isaac",
    });
    expect(page.results[0]?.snippet.length).toBeLessThanOrEqual(240);
  });

  it("preserves the prior session corpus and source state when full replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-search-index-"));
    const index = openSearchIndex({ stateDir: join(root, "state") });
    indexes.push(index);
    const state = {
      instanceId: "isaac",
      principalId: "isaac",
      sourcePath: "session.jsonl",
      device: 1,
      inode: 2,
      sizeBytes: 100,
      modifiedMs: 3,
      completedOffset: 100,
      prefixHash: "sha256:original",
    };
    const original = {
      instanceId: "isaac",
      principalId: "isaac",
      sessionId: "session-original",
      entryId: "entry-original",
      timestamp: "2026-01-01T00:00:00.000Z",
      role: "user",
      project: null,
      cwd: null,
      sourcePath: state.sourcePath,
      sourceOffset: 1,
      searchableText: "original session evidence",
    };
    index.replaceSessionCorpus("isaac", "isaac", [state], [original]);

    expect(() =>
      index.replaceSessionCorpus(
        "isaac",
        "isaac",
        [{ ...state, prefixHash: "sha256:new" }],
        [
          { ...original, searchableText: "replacement one" },
          { ...original, searchableText: "replacement duplicate" },
        ],
      ),
    ).toThrow();

    expect(index.searchSessions("original", 10).results).toHaveLength(1);
    expect(index.getSessionSourceState("isaac", "isaac", state.sourcePath)).toEqual(state);
  });
});
