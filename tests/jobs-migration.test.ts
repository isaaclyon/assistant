import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLegacyJobLedger, inspectLegacyJobMigration, parseMigrationJson } from "../src/jobs-migration.js";
import { openJobOccurrenceLedger } from "../src/job-occurrences.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legacy-migration-")); roots.push(root);
  const coordinator = join(root, "coordinator");
  const recipients = { isaac: join(root, "isaac"), emma: join(root, "emma") };
  for (const path of [coordinator, ...Object.values(recipients)]) await mkdir(path, { mode: 0o700 });
  const eventHash = createHash("sha256").update("legacy-event").digest("hex");
  const dispatchId = `example-${eventHash.slice(0, 16)}`;
  const dispatch = { version: 1, dispatchId, eventHash, jobId: "example", target: "both-personal",
    recipients: { isaac: "enqueued", emma: "enqueued" }, createdAt: "2026-01-01T00:00:00.000Z" };
  async function save(path: string, data: unknown) {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
  }
  const dispatchPath = join(coordinator, "job-dispatches", `${dispatchId}.json`);
  await save(dispatchPath, dispatch);
  async function handoff(recipient: keyof typeof recipients, state = "completed", extra = {}) {
    const path = join(recipients[recipient], "job-handoffs", state, `${dispatchId}.json`);
    await save(path, { version: 1, dispatchId, jobId: "example", jobType: "cron", target: recipient,
      prompt: "Synthetic private prompt", createdAt: dispatch.createdAt, ...extra });
    return path;
  }
  return { coordinatorStateDir: coordinator, recipients, dispatch, dispatchPath, handoff, save };
}

describe("offline legacy migration inventory", () => {
  it("rejects duplicate JSON keys, including escaped equivalents", () => {
    expect(() => parseMigrationJson('{"fired":{},"fi\\u0072ed":{}}')).toThrow(/duplicate/i);
    expect(parseMigrationJson('{"a":[{"b":1},{"b":2}]}')).toEqual({ a: [{ b: 1 }, { b: 2 }] });
  });
  it("blocks automatic initialization and refuses fired IDs without exact terminal identity", async () => {
    const f = await fixture(); await f.handoff("isaac"); await f.handoff("emma");
    const statePath = join(f.coordinatorStateDir, "jobs-state.json");
    await f.save(statePath, { fired: { reminder: 1 }, lastRun: {} });
    const job = { id: "reminder", type: "at" as const, at: "2026-01-01T00:00:00Z", prompt: "Synthetic", target: "isaac" };
    expect(() => openJobOccurrenceLedger(f.coordinatorStateDir)).toThrow(/offline migration/i);
    await expect(initializeLegacyJobLedger({ ...f, jobs: [job] })).rejects.toThrow(/cannot prove/i);
  });
  it("refuses malformed scheduler state instead of dropping suppression", async () => {
    const f = await fixture(); await f.handoff("isaac"); await f.handoff("emma");
    await f.save(join(f.coordinatorStateDir, "jobs-state.json"), { fired: { example: "bad" }, lastRun: {} });
    await expect(initializeLegacyJobLedger({ ...f, jobs: [] })).rejects.toThrow(/scheduler state/i);
  });
  it("seeds an exact terminal at handoff when old fired acknowledgement was lost", async () => {
    const f = await fixture();
    const job = { id: "example", type: "at" as const, at: "2026-01-01T00:00:00Z", prompt: "Synthetic", target: "both-personal" };
    const eventHash = createHash("sha256").update(`at:${job.id}:${Date.parse(job.at)}`).digest("hex");
    const dispatchId = `${job.id}-${eventHash.slice(0, 16)}`;
    await rm(f.dispatchPath);
    await f.save(join(f.coordinatorStateDir, "job-dispatches", `${dispatchId}.json`), { ...f.dispatch, dispatchId, eventHash });
    for (const [target, root] of Object.entries(f.recipients)) {
      await f.save(join(root, "job-handoffs", "completed", `${dispatchId}.json`), { version: 1,
        dispatchId, jobId: job.id, jobType: "at", target, createdAt: f.dispatch.createdAt,
        prompt: `One-time reminder '${job.id}' fired (scheduled for ${job.at}).\n\n${job.prompt}` });
    }
    await f.save(join(f.coordinatorStateDir, "jobs-state.json"), { fired: {}, lastRun: {} });
    expect((await inspectLegacyJobMigration({ ...f, jobs: [job] })).suppressAt).toEqual([job.id]);
    await expect(inspectLegacyJobMigration({ ...f, jobs: [{ ...job, prompt: "Edited" }] })).rejects.toThrow(/cannot prove/i);
    await initializeLegacyJobLedger({ ...f, jobs: [job] });
    const ledger = openJobOccurrenceLedger(f.coordinatorStateDir);
    try { expect(ledger.oneShotPublished(job)).toBe(true); expect(ledger.pending()).toEqual([]); }
    finally { ledger.close(); }
  });
  it("permits terminal fanout without changing or revealing canonical payloads", async () => {
    const f = await fixture(); const paths = await Promise.all([f.handoff("isaac"), f.handoff("emma")]);
    const before = await Promise.all(paths.map((p) => readFile(p, "utf8")));
    const report = await inspectLegacyJobMigration(f);
    expect(report).toMatchObject({ dispatches: 1, recipientFiles: 2 });
    expect(JSON.stringify(report)).not.toContain("Synthetic private prompt");
    expect(await Promise.all(paths.map((p) => readFile(p, "utf8")))).toEqual(before);
  });
  it.each(["pending", "processing", "failed"])("refuses unresolved %s rather than guessing historical identity", async (state) => {
    const f = await fixture(); await f.handoff("isaac", state); await f.handoff("emma");
    await expect(inspectLegacyJobMigration(f)).rejects.toThrow(/unresolved/i);
  });
  it("refuses lost and conflicting recipient evidence", async () => {
    const f = await fixture(); await f.handoff("isaac");
    await expect(inspectLegacyJobMigration(f)).rejects.toThrow(/missing/i);
    await f.handoff("emma"); await f.handoff("isaac", "acknowledged");
    await expect(inspectLegacyJobMigration(f)).rejects.toThrow(/conflicting/i);
  });
  it("refuses mismatched sibling payloads and unknown recipient directories", async () => {
    const f = await fixture(); await f.handoff("isaac"); await f.handoff("emma", "completed", { prompt: "Different" });
    await expect(inspectLegacyJobMigration(f)).rejects.toThrow(/payload/i);
    await f.handoff("emma"); await mkdir(join(f.recipients.emma, "job-handoffs", "unknown"));
    await expect(inspectLegacyJobMigration(f)).rejects.toThrow(/unknown/i);
  });
  it("rejects orphan evidence and unsafe files", async () => {
    const f = await fixture(); const path = await f.handoff("isaac"); await f.handoff("emma");
    await rm(f.dispatchPath);
    await expect(inspectLegacyJobMigration(f)).rejects.toThrow(/orphan/i);
    await f.save(f.dispatchPath, f.dispatch);
    const { chmod } = await import("node:fs/promises"); await chmod(path, 0o644);
    await expect(inspectLegacyJobMigration(f)).rejects.toThrow(/private/i);
  });
});
