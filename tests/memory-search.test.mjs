import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMarkdownMemorySearchBackend,
} from "../.pi/skills/personal-memory/scripts/search.mjs";
import { createMarkdownMemoryStore } from "../.pi/skills/personal-memory/scripts/store.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "personal-memory-search-"));
  roots.push(sandbox);
  const root = join(sandbox, "vault");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  let sequence = 0;
  const store = createMarkdownMemoryStore({
    root,
    now: () => new Date("2026-07-19T03:30:00.000Z"),
    randomUUID: () => ids[sequence++],
  });
  const backend = createMarkdownMemorySearchBackend({ root, ...options });
  return { backend, root, store };
}

const backendFactories = [
  ["markdown", async () => fixture()],
];

describe.each(backendFactories)("%s memory search contract", (_name, makeFixture) => {
  it("returns the stable result and page shape", async () => {
    const { backend, store } = await makeFixture();
    const added = await store.add({
      type: "preference",
      title: "Coffee preference",
      tags: ["coffee", "food"],
      body: "Prefers a light roast.",
    });

    await expect(backend.search({ query: "coffee", limit: 10 })).resolves.toEqual({
      results: [{ ...added, snippet: "Prefers a light roast.", score: expect.any(Number) }],
      truncated: false,
      scanTruncated: false,
      warnings: [],
      warningsTruncated: false,
    });
  });

  it("normalizes Unicode and case and requires every token", async () => {
    const { backend, store } = await makeFixture();
    await store.add({ type: "preference", title: "CAFÉ choice", tags: ["Morning"], body: "Light roast only." });
    await store.add({ type: "preference", title: "Coffee", body: "Dark roast only." });

    const page = await backend.search({ query: "cafe\u0301 LIGHT" });
    expect(page.results.map((result) => result.title)).toEqual(["CAFÉ choice"]);
  });

  it("weights title phrase above tags and body and breaks ties deterministically", async () => {
    const { backend, store } = await makeFixture();
    const body = await store.add({ type: "reference", title: "Alpha", body: "coffee beans" });
    const tag = await store.add({ type: "reference", title: "Beta", tags: ["coffee", "beans"], body: "Elsewhere" });
    const title = await store.add({ type: "reference", title: "Coffee beans", body: "Elsewhere" });

    const page = await backend.search({ query: "coffee beans" });
    expect(page.results.map((result) => result.id)).toEqual([title.id, tag.id, body.id]);
    expect(page.results[0].score).toBeGreaterThan(page.results[1].score);
    expect(page.results[1].score).toBeGreaterThan(page.results[2].score);
  });

  it("filters types, caps results, and reports truncation", async () => {
    const { backend, store } = await makeFixture();
    await store.add({ type: "event", title: "Tea one", body: "Tea" });
    await store.add({ type: "event", title: "Tea two", body: "Tea" });
    await store.add({ type: "recipe", title: "Tea recipe", body: "Tea" });

    const page = await backend.search({ query: "tea", types: ["event"], limit: 1 });
    expect(page.results).toHaveLength(1);
    expect(page.results[0].type).toBe("event");
    expect(page.truncated).toBe(true);
  });
});

describe("Markdown memory search safety and bounds", () => {
  it("bounds snippets and validates query and limit", async () => {
    const { backend, store } = await fixture();
    await store.add({ type: "reference", title: "Needle", body: `prefix needle ${"x".repeat(1000)}` });

    const page = await backend.search({ query: "needle" });
    expect(page.results[0].snippet.length).toBeLessThanOrEqual(240);
    await expect(backend.search({ query: "x".repeat(513) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(backend.search({ query: "needle", limit: 51 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("skips malformed and unsafe notes with bounded warnings", async () => {
    const { backend, root, store } = await fixture({ maxWarnings: 1 });
    const malformed = await store.add({ type: "reference", title: "Malformed", body: "needle" });
    const raw = await readFile(join(root, malformed.relativePath), "utf8");
    await writeFile(join(root, malformed.relativePath), raw.replace("title:", "title: \"duplicate\"\ntitle:"));
    await mkdir(join(root, "people"), { recursive: true, mode: 0o700 });
    const unsafeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await symlink(join(root, "missing"), join(root, "people", `${unsafeId}.md`));

    const page = await backend.search({ query: "needle" });
    expect(page.results).toEqual([]);
    expect(page.warnings).toHaveLength(1);
    expect(page.warnings[0]).toEqual({
      code: expect.stringMatching(/^(MALFORMED_NOTE|UNSAFE_ENTRY)$/),
      relativePath: expect.stringMatching(/^[a-z]+\/[0-9a-f-]+\.md$/),
    });
    expect(page.warningsTruncated).toBe(true);
  });

  it("scans candidates in path order and reports the scan cap", async () => {
    const { root, store } = await fixture();
    await store.add({ type: "reference", title: "First needle", body: "needle" });
    await store.add({ type: "reference", title: "Second needle", body: "needle" });
    const backend = createMarkdownMemorySearchBackend({ root, maxScannedNotes: 1 });

    const page = await backend.search({ query: "needle" });
    expect(page.results).toHaveLength(1);
    expect(page.scanTruncated).toBe(true);
  });
});
