import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_TYPES,
  MemoryError,
  createMarkdownMemoryStore,
} from "../.pi/skills/personal-memory/scripts/store.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const sandbox = await mkdtemp(join(tmpdir(), "personal-memory-"));
  roots.push(sandbox);
  const root = join(sandbox, "vault");
  let sequence = 0;
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const store = createMarkdownMemoryStore({
    root,
    forbiddenRoots: [join(sandbox, "repo"), join(sandbox, "release")],
    now: () => new Date("2026-07-19T03:30:00.000Z"),
    randomUUID: () => ids[sequence++],
  });
  return { sandbox, root, store };
}

async function expectMemoryError(promise, code) {
  await expect(promise).rejects.toMatchObject({ name: "MemoryError", code });
}

describe("Markdown personal memory store", () => {
  it("creates a private canonical note and round-trips it", async () => {
    const { root, store } = await fixture();
    const added = await store.add({
      type: "preference",
      title: "Coffee preference",
      tags: ["coffee", "food"],
      body: "Prefers light-roast coffee.\n",
    });

    expect(added).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      type: "preference",
      title: "Coffee preference",
      tags: ["coffee", "food"],
      relativePath: "preferences/11111111-1111-4111-8111-111111111111.md",
    });
    expect(added.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(readFile(join(root, added.relativePath), "utf8")).resolves.toBe(
      `---\nid: "11111111-1111-4111-8111-111111111111"\ntype: "preference"\ntitle: "Coffee preference"\ntags: ["coffee","food"]\ncreated: "2026-07-19T03:30:00.000Z"\nupdated: "2026-07-19T03:30:00.000Z"\n---\nPrefers light-roast coffee.\n`,
    );
    await expect(store.read({ id: added.id })).resolves.toMatchObject({
      ...added,
      body: "Prefers light-roast coffee.\n",
    });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "preferences"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, added.relativePath))).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).some((name) => name.endsWith(".db"))).toBe(false);
  });

  it("updates by revision while preserving unknown frontmatter and an unspecified body", async () => {
    const { root, store } = await fixture();
    const added = await store.add({
      type: "person",
      title: "Synthetic person",
      tags: [],
      body: "Original body.\n",
    });
    const path = join(root, added.relativePath);
    const raw = await readFile(path, "utf8");
    await writeFile(
      path,
      raw.replace('title: "Synthetic person"\n', 'title: "Synthetic person"\n# kept comment\naliases:\n  - Example\n'),
      { mode: 0o600 },
    );
    const current = await store.read({ id: added.id });

    const updated = await store.update({
      id: added.id,
      ifRevision: current.revision,
      patch: { title: "Updated synthetic person", tags: ["example"] },
    });

    expect(updated.body).toBe("Original body.\n");
    const updatedRaw = await readFile(path, "utf8");
    expect(updatedRaw).toContain("# kept comment\naliases:\n  - Example\n");
    expect(updatedRaw).toContain('title: "Updated synthetic person"');
    expect(updated.revision).not.toBe(current.revision);
  });

  it("rejects stale revisions and leaves the prior note unchanged", async () => {
    const { root, store } = await fixture();
    const added = await store.add({ type: "event", title: "Example event", body: "At noon." });
    const path = join(root, added.relativePath);
    const before = await readFile(path, "utf8");

    await expectMemoryError(
      store.update({ id: added.id, ifRevision: "sha256:stale", patch: { body: "Changed" } }),
      "REVISION_CONFLICT",
    );
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readdir(dirname(path))).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("refuses malformed or duplicate managed frontmatter", async () => {
    const { root, store } = await fixture();
    const added = await store.add({ type: "reference", title: "Example reference", body: "Body" });
    const path = join(root, added.relativePath);
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("title:", "title: \"duplicate\"\ntitle:"));

    await expectMemoryError(store.read({ id: added.id }), "MALFORMED_NOTE");

    await mkdir(join(root, "people"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "people", `${added.id}.md`), raw, { mode: 0o600 });
    await expectMemoryError(store.read({ id: added.id }), "DUPLICATE_ID");
  });

  it("requires an exact confirmation and current revision to hard-delete", async () => {
    const { root, store } = await fixture();
    const added = await store.add({ type: "purchase", title: "Synthetic purchase", body: "Test only." });

    await expectMemoryError(
      store.delete({ id: added.id, ifRevision: added.revision, confirmId: "wrong" }),
      "CONFIRMATION_REQUIRED",
    );
    await expectMemoryError(
      store.delete({ id: added.id, ifRevision: "sha256:stale", confirmId: added.id }),
      "REVISION_CONFLICT",
    );
    await expect(store.delete({ id: added.id, ifRevision: added.revision, confirmId: added.id })).resolves.toEqual({
      id: added.id,
      deleted: true,
    });
    await expectMemoryError(store.read({ id: added.id }), "NOT_FOUND");
    await expect(readFile(join(root, added.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates types, ids, and input bounds", async () => {
    const { store } = await fixture();
    expect(MEMORY_TYPES).toEqual([
      "person",
      "preference",
      "event",
      "list",
      "recipe",
      "purchase",
      "reference",
    ]);
    await expectMemoryError(store.add({ type: "secret", title: "No", body: "No" }), "INVALID_INPUT");
    await expectMemoryError(store.add({ type: "person", title: "x".repeat(201), body: "No" }), "INVALID_INPUT");
    await expectMemoryError(store.add({ type: "person", title: "Valid", tags: Array(33).fill("tag"), body: "No" }), "INVALID_INPUT");
    await expectMemoryError(store.read({ id: "../../etc/passwd" }), "INVALID_ID");
  });

  it("rejects vaults inside forbidden roots before writing", async () => {
    const { sandbox } = await fixture();
    const forbidden = join(sandbox, "repo");
    expect(() =>
      createMarkdownMemoryStore({
        root: join(forbidden, "memory"),
        forbiddenRoots: [forbidden],
      }),
    ).toThrow(expect.objectContaining({ name: "MemoryError", code: "UNSAFE_VAULT" }));
    await expect(lstat(join(forbidden, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses symlinked roots, type directories, notes, and non-regular notes", async () => {
    const { sandbox } = await fixture();
    const target = join(sandbox, "target");
    const linkedRoot = join(sandbox, "linked-vault");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linkedRoot, "dir");
    const rootStore = createMarkdownMemoryStore({ root: linkedRoot });
    await expectMemoryError(
      rootStore.add({ type: "person", title: "No", body: "No" }),
      "UNSAFE_VAULT",
    );

    const root = join(sandbox, "vault-two");
    await mkdir(root, { mode: 0o700 });
    await symlink(target, join(root, "people"), "dir");
    const store = createMarkdownMemoryStore({ root });
    await expectMemoryError(
      store.add({ type: "person", title: "No", body: "No" }),
      "UNSAFE_ENTRY",
    );

    await rm(join(root, "people"));
    await mkdir(join(root, "people"), { mode: 0o700 });
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await symlink(join(sandbox, "missing"), join(root, "people", `${id}.md`));
    await expectMemoryError(store.read({ id }), "UNSAFE_ENTRY");
    await rm(join(root, "people", `${id}.md`));
    await mkdir(join(root, "people", `${id}.md`));
    await expectMemoryError(store.read({ id }), "UNSAFE_ENTRY");
  });

  it("lists managed notes deterministically without following unrelated content", async () => {
    const { root, store } = await fixture();
    const first = await store.add({ type: "recipe", title: "First recipe", body: "One" });
    const second = await store.add({ type: "list", title: "Example list", body: "Two" });
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, "README.md"), "ignore me");
    await chmod(join(root, "README.md"), 0o600);

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: first.id, relativePath: first.relativePath }),
      expect.objectContaining({ id: second.id, relativePath: second.relativePath }),
    ]);
  });
});
