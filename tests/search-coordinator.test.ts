import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  rebuildMemoryIndex,
  rebuildSessionIndex,
  refreshSessionIndex,
  searchIndexedMemories,
  searchIndexedSessions,
} from "../src/search-coordinator.js";
import { openSearchIndex, type SearchIndex } from "../src/search-index.js";

const roots: string[] = [];
const indexes: SearchIndex[] = [];

afterEach(async () => {
  for (const index of indexes.splice(0)) index.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("search coordinator", () => {
  it("rebuilds canonical Markdown and returns privacy-filtered indexed results", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const vault = join(sandbox, "vault");
    const stateDir = join(sandbox, "state");
    const resourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const storeModule = await import(pathToFileURL(join(
      resourceRoot,
      ".pi",
      "skills",
      "personal-memory",
      "scripts",
      "store.mjs",
    )).href) as {
      createMarkdownMemoryStore(options: Record<string, unknown>): {
        add(request: Record<string, unknown>): Promise<{ id: string }>;
      };
    };
    let sequence = 0;
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const store = storeModule.createMarkdownMemoryStore({
      root: vault,
      principal: "isaac",
      memoryView: "owner-and-household",
      randomUUID: () => ids[sequence++],
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    await store.add({
      type: "preference",
      scope: "personal",
      title: "Private coffee preference",
      tags: ["coffee"],
      body: "Prefers a light roast.",
    });
    await store.add({
      type: "reference",
      scope: "household",
      title: "Household coffee guide",
      tags: ["coffee"],
      body: "Shared grinder settings.",
    });
    const index = openSearchIndex({ stateDir });
    indexes.push(index);

    const rebuilt = await rebuildMemoryIndex({ index, vaultRoot: vault, resourceRoot });
    const personal = searchIndexedMemories(index, {
      query: "coffee",
      principal: "isaac",
      memoryView: "owner-and-household",
      limit: 10,
    });
    const household = searchIndexedMemories(index, {
      query: "coffee",
      principal: "household",
      memoryView: "household",
      limit: 10,
    });

    expect(rebuilt).toMatchObject({ indexed: 2, warnings: [] });
    expect(personal.results).toHaveLength(2);
    expect(personal.results[0]).toMatchObject({
      source: "memory",
      id: expect.any(String),
      relativePath: expect.stringMatching(/\.md$/u),
      revision: expect.stringMatching(/^sha256:/u),
      snippet: expect.any(String),
    });
    expect(household.results.map((result) => result.scope)).toEqual(["household"]);
  });

  it("reconciles memory edits and deletions without stale indexed rows", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const vault = join(sandbox, "vault");
    const resourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const storeModule = await import(pathToFileURL(join(
      resourceRoot,
      ".pi",
      "skills",
      "personal-memory",
      "scripts",
      "store.mjs",
    )).href) as {
      createMarkdownMemoryStore(options: Record<string, unknown>): {
        add(request: Record<string, unknown>): Promise<{ id: string; revision: string }>;
        update(request: Record<string, unknown>): Promise<{ id: string; revision: string }>;
        delete(request: Record<string, unknown>): Promise<unknown>;
      };
    };
    const store = storeModule.createMarkdownMemoryStore({
      root: vault,
      principal: "isaac",
      memoryView: "owner-and-household",
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const added = await store.add({
      type: "reference",
      title: "Original phrase",
      body: "old needle",
    });
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);
    await rebuildMemoryIndex({ index, vaultRoot: vault, resourceRoot });
    const updated = await store.update({
      id: added.id,
      ifRevision: added.revision,
      patch: { title: "Replacement phrase", body: "new needle" },
    });
    await rebuildMemoryIndex({ index, vaultRoot: vault, resourceRoot });

    expect(searchIndexedMemories(index, {
      query: "original",
      principal: "isaac",
      memoryView: "owner-and-household",
    }).results).toEqual([]);
    expect(searchIndexedMemories(index, {
      query: "replacement",
      principal: "isaac",
      memoryView: "owner-and-household",
    }).results).toEqual([expect.objectContaining({ id: added.id, revision: updated.revision })]);

    await store.delete({
      id: added.id,
      ifRevision: updated.revision,
      confirmId: added.id,
    });
    await rebuildMemoryIndex({ index, vaultRoot: vault, resourceRoot });
    expect(index.status().memoryDocuments).toBe(0);
  });

  it("caps deterministic memory rebuild candidates and reports scan truncation", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const vault = join(sandbox, "vault");
    const resourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const storeModule = await import(pathToFileURL(join(
      resourceRoot,
      ".pi",
      "skills",
      "personal-memory",
      "scripts",
      "store.mjs",
    )).href) as {
      createMarkdownMemoryStore(options: Record<string, unknown>): {
        add(request: Record<string, unknown>): Promise<unknown>;
      };
    };
    let sequence = 0;
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const store = storeModule.createMarkdownMemoryStore({
      root: vault,
      randomUUID: () => ids[sequence++],
    });
    await store.add({ type: "reference", title: "First", body: "needle" });
    await store.add({ type: "reference", title: "Second", body: "needle" });
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);

    const rebuilt = await rebuildMemoryIndex({
      index,
      vaultRoot: vault,
      resourceRoot,
      maxNotes: 1,
    });

    expect(rebuilt).toMatchObject({ indexed: 1, scanTruncated: true });
    expect(index.status().memoryDocuments).toBe(1);
  });

  it("refreshes an explicit session root and returns source-aware results", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const sessionRoot = join(sandbox, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const path = join(sessionRoot, "session-1.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-07-25T12:00:00.000Z",
          cwd: "/private/assistant",
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          timestamp: "2026-07-25T12:01:00.000Z",
          message: { role: "user", content: "Discuss rebuildable indexes" },
        }),
        "",
      ].join("\n"),
    );
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);

    const refreshed = await refreshSessionIndex({
      index,
      roots: [sessionRoot],
      instanceId: "isaac",
      principalId: "isaac",
      includeSafeCwd: true,
    });
    const page = searchIndexedSessions(index, {
      query: "rebuildable",
      instanceId: "isaac",
      principalId: "isaac",
      limit: 10,
    });

    expect(refreshed).toMatchObject({
      files: 1,
      indexed: 1,
      skipped: 0,
      warnings: [],
    });
    expect(page).toEqual({
      results: [
        expect.objectContaining({
          source: "session",
          sessionId: "session-1",
          entryId: "entry-1",
          timestamp: "2026-07-25T12:01:00.000Z",
          role: "user",
          project: "assistant",
          sourcePath: path,
          sourceOffset: expect.any(Number),
          snippet: expect.stringContaining("rebuildable"),
        }),
      ],
      truncated: false,
    });
    expect(searchIndexedSessions(index, {
      query: "rebuildable",
      instanceId: "emma",
      principalId: "emma",
      limit: 10,
    }).results).toEqual([]);
  });

  it("skips unchanged sessions and resumes append-only files without duplicating entries", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const sessionRoot = join(sandbox, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const path = join(sessionRoot, "session-1.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-07-25T12:00:00.000Z",
    };
    const message = (id: string, content: string) => ({
      type: "message",
      id,
      timestamp: `2026-07-25T12:0${id === "entry-1" ? "1" : "2"}:00.000Z`,
      message: { role: "user", content },
    });
    await writeFile(
      path,
      `${JSON.stringify(header)}\n${JSON.stringify(message("entry-1", "index alpha"))}\n`,
    );
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);
    const options = {
      index,
      roots: [sessionRoot],
      instanceId: "isaac",
      principalId: "isaac",
    };

    const first = await refreshSessionIndex(options);
    const unchanged = await refreshSessionIndex(options);
    await appendFile(path, `${JSON.stringify(message("entry-2", "index beta"))}\n`);
    const appended = await refreshSessionIndex(options);

    expect(first).toMatchObject({ rebuiltFiles: 1, appendedFiles: 0, unchangedFiles: 0 });
    expect(unchanged).toMatchObject({ rebuiltFiles: 0, appendedFiles: 0, unchangedFiles: 1 });
    expect(appended).toMatchObject({ rebuiltFiles: 0, appendedFiles: 1, unchangedFiles: 0 });
    expect(searchIndexedSessions(index, {
      query: "index",
      instanceId: "isaac",
      principalId: "isaac",
      limit: 10,
    }).results.map((result) => result.entryId).sort()).toEqual(["entry-1", "entry-2"]);
  });

  it("reconciles rewritten and deleted session files without stale results", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const sessionRoot = join(sandbox, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const path = join(sessionRoot, "session-1.jsonl");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-07-25T12:00:00.000Z",
    });
    const line = (id: string, content: string) => JSON.stringify({
      type: "message",
      id,
      timestamp: "2026-07-25T12:01:00.000Z",
      message: { role: "assistant", content },
    });
    await writeFile(path, `${header}\n${line("old", "stale phrase")}\n`);
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);
    const options = {
      index,
      roots: [sessionRoot],
      instanceId: "isaac",
      principalId: "isaac",
    };
    await refreshSessionIndex(options);

    await writeFile(
      path,
      `${header}\n${line("new", `fresh phrase ${"larger ".repeat(30)}`)}\n`,
    );
    const rewritten = await refreshSessionIndex(options);
    expect(rewritten).toMatchObject({ rebuiltFiles: 1 });
    expect(searchIndexedSessions(index, {
      query: "stale",
      instanceId: "isaac",
      principalId: "isaac",
    }).results).toEqual([]);
    expect(searchIndexedSessions(index, {
      query: "fresh",
      instanceId: "isaac",
      principalId: "isaac",
    }).results.map((result) => result.entryId)).toEqual(["new"]);

    await rm(path);
    const deleted = await refreshSessionIndex(options);
    expect(deleted).toMatchObject({ deletedFiles: 1 });
    expect(index.status().sessionDocuments).toBe(0);
  });

  it("caps session files deterministically and reports traversal truncation", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const sessionRoot = join(sandbox, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const content = (sessionId: string, entryId: string) => [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-07-25T12:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        id: entryId,
        timestamp: "2026-07-25T12:01:00.000Z",
        message: { role: "user", content: "bounded traversal" },
      }),
      "",
    ].join("\n");
    await writeFile(join(sessionRoot, "b.jsonl"), content("b", "b-entry"));
    await writeFile(join(sessionRoot, "a.jsonl"), content("a", "a-entry"));
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);

    const refreshed = await refreshSessionIndex({
      index,
      roots: [sessionRoot],
      instanceId: "isaac",
      principalId: "isaac",
      maxFiles: 1,
    });

    expect(refreshed).toMatchObject({ files: 1, filesTruncated: true });
    expect(searchIndexedSessions(index, {
      query: "bounded",
      instanceId: "isaac",
      principalId: "isaac",
    }).results.map((result) => result.sessionId)).toEqual(["a"]);
  });

  it("atomically rebuilds the active session corpus and converges on repeated runs", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const sessionRoot = join(sandbox, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const path = join(sessionRoot, "session.jsonl");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "session",
      timestamp: "2026-07-25T12:00:00.000Z",
      cwd: "/work/alpha",
    });
    const message = (id: string, role: string, timestamp: string, content: string) =>
      JSON.stringify({
        type: "message",
        id,
        timestamp,
        message: { role, content },
      });
    await writeFile(
      path,
      `${header}\n${message("old", "user", "2026-07-25T12:01:00.000Z", "replace me")}\n`,
    );
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);
    const options = {
      index,
      roots: [sessionRoot],
      instanceId: "isaac",
      principalId: "isaac",
      includeSafeCwd: true,
    };
    await rebuildSessionIndex(options);
    await writeFile(
      path,
      `${header}\n${message("new", "assistant", "2026-07-25T12:02:00.000Z", "replacement evidence")}\n`,
    );

    const first = await rebuildSessionIndex(options);
    const second = await rebuildSessionIndex(options);

    expect(first).toMatchObject({ files: 1, indexed: 1, rebuiltFiles: 1 });
    expect(second).toEqual(first);
    expect(searchIndexedSessions(index, {
      query: "replace",
      instanceId: "isaac",
      principalId: "isaac",
      roles: ["user"],
    }).results).toEqual([]);
    expect(searchIndexedSessions(index, {
      query: "replacement",
      instanceId: "isaac",
      principalId: "isaac",
      roles: ["assistant"],
      from: "2026-07-25T12:02:00.000Z",
      to: "2026-07-25T12:02:00.000Z",
      project: "alpha",
    }).results.map((result) => result.entryId)).toEqual(["new"]);
  });

  it("keeps an incomplete appended line out of the index until it is completed", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "search-coordinator-"));
    roots.push(sandbox);
    const sessionRoot = join(sandbox, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const path = join(sessionRoot, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session",
        timestamp: "2026-07-25T12:00:00.000Z",
      })}\n`,
    );
    const index = openSearchIndex({ stateDir: join(sandbox, "state") });
    indexes.push(index);
    const options = {
      index,
      roots: [sessionRoot],
      instanceId: "isaac",
      principalId: "isaac",
    };
    await refreshSessionIndex(options);
    const line = JSON.stringify({
      type: "message",
      id: "entry",
      timestamp: "2026-07-25T12:01:00.000Z",
      message: { role: "user", content: "partial append evidence" },
    });
    await appendFile(path, line.slice(0, 20));
    await refreshSessionIndex(options);
    expect(index.status().sessionDocuments).toBe(0);
    await appendFile(path, `${line.slice(20)}\n`);
    await refreshSessionIndex(options);
    expect(searchIndexedSessions(index, {
      query: "partial",
      instanceId: "isaac",
      principalId: "isaac",
    }).results.map((result) => result.entryId)).toEqual(["entry"]);
  });
});
