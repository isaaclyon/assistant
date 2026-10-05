import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryApplication } from "../src/memory-application.js";
import { executeMemoryOperation } from "../.pi/skills/personal-memory/scripts/memory.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memory-application-")); roots.push(root);
  const env = { PI_TELEGRAM_MEMORY_DIR: join(root, "vault"), PI_TELEGRAM_BRIDGE_STATE_DIR: join(root, "state"),
    PI_TELEGRAM_PRINCIPAL: "isaac", PI_TELEGRAM_MEMORY_VIEW: "owner-and-household" };
  const findDuplicates = vi.fn(async () => ({ results: [], truncated: false }));
  let now = 0;
  const app = new MemoryApplication({ env, findDuplicates, now: () => now });
  const prepare = () => app.prepareCreate({ type: "preference", title: "Dining", body: "Quiet restaurants. Likes coffee." });
  const draft = await prepare();
  const note = await app.create(draft.creationToken);
  return { app, env, note, findDuplicates, prepare, expire: () => { now = 600_001; } };
}

it("requires a duplicate check, binds the draft, and makes repeated create calls idempotent", async () => {
  const { app, findDuplicates, prepare } = await fixture();
  await expect(app.create("invented-token")).rejects.toMatchObject({ code: "STALE_ACTION" });
  const draft = await prepare();
  expect(findDuplicates).toHaveBeenCalledTimes(2);
  const results = await Promise.all([app.create(draft.creationToken), app.create(draft.creationToken)]);
  expect(results[0]!.id).toBe(results[1]!.id);
  expect((await app.create(draft.creationToken)).id).toBe(results[0]!.id);
});

it("applies exact text edits, preserves unrelated content, and rejects stale or ambiguous edits atomically", async () => {
  const { app, note } = await fixture();
  const updated = await app.update(String(note.id), String(note.revision), {
    bodyEdits: [{ expectedText: "Quiet restaurants.", replacementText: "Quiet restaurants with my parents." }],
  });
  expect(updated.body).toBe("Quiet restaurants with my parents. Likes coffee.");
  await expect(app.update(String(note.id), String(note.revision), { title: "stale" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(app.update(String(note.id), String(updated.revision), { bodyEdits: [
    { expectedText: "Likes coffee.", replacementText: "Likes tea." },
    { expectedText: "missing", replacementText: "oops" },
  ] })).rejects.toMatchObject({ code: "TEXT_CONFLICT" });
  expect((await app.read(String(note.id))).body).toBe(updated.body);
  await expect(app.update(String(note.id), String(updated.revision), {
    bodyEdits: [{ expectedText: " ", replacementText: "" }],
  })).rejects.toMatchObject({ code: "TEXT_CONFLICT" });
});

it("prevents CLI confirmation forgery and binds approval to the operation, chat and revision", async () => {
  const { app, note, env } = await fixture();
  const id = String(note.id), revision = String(note.revision);
  await expect(executeMemoryOperation("delete", { id, ifRevision: revision, confirmId: id, confirmed: true }, { env }))
    .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  await expect(executeMemoryOperation("update", { id, ifRevision: revision, patch: { scope: "household" } }, { env }))
    .rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  const pending = await app.requestConfirmation("share", id, revision);
  await expect(app.confirm(pending.token, 1)).rejects.toMatchObject({ code: "STALE_ACTION" });
  app.bindConfirmation(pending.token, 1);
  await expect(app.confirm(pending.token, 2)).rejects.toMatchObject({ code: "STALE_ACTION" });
  expect((await app.confirm(pending.token, 1)).scope).toBe("household");
  await expect(app.confirm(pending.token, 1)).rejects.toMatchObject({ code: "STALE_ACTION" });
  const current = await app.read(id);
  const deletion = await app.requestConfirmation("delete", id, String(current.revision));
  app.bindConfirmation(deletion.token, 1);
  await app.update(id, String(current.revision), { title: "Changed after preview" });
  await expect(app.confirm(deletion.token, 1)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect((await app.read(id)).title).toBe("Changed after preview");
});

it("invalidates cancelled, expired and session-reset approvals; accepts a fresh deletion once", async () => {
  const { app, note, expire } = await fixture();
  const id = String(note.id), revision = String(note.revision);
  const cancelled = await app.requestConfirmation("delete", id, revision);
  app.bindConfirmation(cancelled.token, 1); app.cancel(cancelled.token, 1);
  await expect(app.confirm(cancelled.token, 1)).rejects.toMatchObject({ code: "STALE_ACTION" });
  const expired = await app.requestConfirmation("delete", id, revision);
  app.bindConfirmation(expired.token, 1); expire();
  await expect(app.confirm(expired.token, 1)).rejects.toMatchObject({ code: "STALE_ACTION" });
  const reset = await app.requestConfirmation("delete", id, revision);
  app.bindConfirmation(reset.token, 1); app.clear();
  await expect(app.confirm(reset.token, 1)).rejects.toMatchObject({ code: "STALE_ACTION" });
  const fresh = await app.requestConfirmation("delete", id, revision);
  app.bindConfirmation(fresh.token, 1);
  expect(await app.confirm(fresh.token, 1)).toMatchObject({ deleted: true });
  await expect(app.read(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("keeps personal notes out of other principals' reads and approvals", async () => {
  const { note, env } = await fixture();
  const other = new MemoryApplication({ env: { ...env, PI_TELEGRAM_PRINCIPAL: "emma" } });
  await expect(other.read(String(note.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(other.requestConfirmation("delete", String(note.id), String(note.revision))).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("suggests existing notes through the actual index without saving a draft, and fails closed on a missing populated vault", async () => {
  const { note, env } = await fixture();
  const app = new MemoryApplication({ env });
  const prepared = await app.prepareCreate({ type: "preference", title: "Dining", body: "Quiet restaurants. Likes coffee." });
  expect(prepared.possibleDuplicates.map(candidate => candidate.id)).toContain(note.id);
  const listed = await executeMemoryOperation("list", {}, { env });
  expect(listed.memories).toHaveLength(1);
  await rename(env.PI_TELEGRAM_MEMORY_DIR, `${env.PI_TELEGRAM_MEMORY_DIR}-moved`);
  await expect(app.prepareCreate({ type: "preference", title: "Dining", body: "Quiet restaurants." }))
    .rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
});

it("binds creation to its validated content, expires drafts, and accepts no scope override", async () => {
  const { app, expire } = await fixture();
  const input = { type: "preference", title: "Original", body: "Original content" };
  const prepared = await app.prepareCreate(input);
  input.body = "Changed behind the draft";
  const created = await app.create(prepared.creationToken);
  expect((await app.read(String(created.id))).body).toBe("Original content");
  const expired = await app.prepareCreate(input); expire();
  await expect(app.create(expired.creationToken)).rejects.toMatchObject({ code: "STALE_ACTION" });
  await expect(app.prepareCreate({ ...input, scope: "household" } as typeof input))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(() => app.update(String(created.id), String(created.revision), { scope: "household" } as never))
    .toThrow(/confirmation/);
});

it("applies diff hunks with revision checks and atomic conflicts", async () => {
  const { app, note } = await fixture();
  const id = String(note.id), revision = String(note.revision);
  const bodyDiff = [" Quiet restaurants. Likes coffee.\n+- Gift idea"];
  const updated = await app.update(id, revision, { bodyDiff });
  expect(updated.body).toBe("Quiet restaurants. Likes coffee.\n- Gift idea");
  await expect(app.update(id, revision, { bodyDiff })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(app.update(id, String(updated.revision), { bodyDiff: ["-- Gift idea\n+- Other", "-missing\n+new"] })).rejects.toMatchObject({ code: "TEXT_CONFLICT" });
  expect((await app.read(id)).body).toBe(updated.body);
  expect(() => app.update(id, String(updated.revision), { bodyDiff: ["+unanchored"] })).toThrow();
  expect(() => app.update(id, String(updated.revision), { bodyDiff: ["@@ header"] })).toThrow();
  expect(() => app.update(id, String(updated.revision), { bodyDiff, bodyEdits: [] })).toThrow();
});
