import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyJobsRequest,
  resolveCoordinatorStateDir,
} from "../src/jobs-cli.js";
import { drainJobHandoffs, enqueueJobHandoff } from "../src/job-handoff.js";

describe("schedule-reminders-and-jobs helper", () => {
  it("inspects and recovers only the host-bound recipient with exact evidence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-cli-recovery-"));
    await enqueueJobHandoff({
      stateRoot: stateDir, coordinatorStateDir: stateDir, local: true, target: "local",
      jobId: "synthetic", eventId: "synthetic", prompt: "Private fixture",
    });
    await drainJobHandoffs({ stateDir, instanceId: "local", inject: async () => {} });
    const inspected = await applyJobsRequest({ operation: "inspect_handoffs" }, { stateDir, env: {} });
    expect(JSON.stringify(inspected)).not.toContain("Private fixture");
    const entry = (inspected.entries as Array<Record<string, unknown>>)[0]!;
    await expect(applyJobsRequest({
      operation: "recover_handoff", dispatchId: entry.dispatchId, state: entry.state,
      revision: entry.revision, action: "retry", target: "emma",
    }, { stateDir, env: {} })).rejects.toThrow(/field/);
    expect(await applyJobsRequest({
      operation: "recover_handoff", dispatchId: entry.dispatchId, state: entry.state,
      revision: entry.revision, action: "acknowledge",
    }, { stateDir, env: {} })).toMatchObject({ ok: true, boundary: "operator_acknowledged" });
  });

  it("does not acknowledge a republished definition with a previous rejection", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-cli-republish-"));
    const request = { operation: "upsert", job: {
      id: "test", type: "cron", target: "isaac", schedule: "0 8 * * *", prompt: "Synthetic",
    } };
    const first = await applyJobsRequest(request, { stateDir, validateReload: false });
    const hash = (first.publication as { hash: string }).hash;
    await writeFile(join(stateDir, "jobs-state.json"), JSON.stringify({
      observedHash: hash, acceptedHash: null, lastLoadError: "Unknown target",
    }));
    const second = await applyJobsRequest(request, { stateDir, reloadTimeoutMs: 1 });
    expect(second).toMatchObject({ ok: true, publication: { status: "pending" } });
    expect((second.publication as { hash: string }).hash).not.toBe(hash);
  });

  it("preserves simultaneous additions to the shared jobs file", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-cli-concurrent-"));
    await Promise.all(Array.from({ length: 10 }, (_, index) => applyJobsRequest({
      operation: "add_at", id: `test-${index}`, target: "isaac", in: "1h", prompt: "Synthetic",
    }, { stateDir, validateReload: false })));
    const stored = JSON.parse(await readFile(join(stateDir, "jobs.json"), "utf8"));
    expect(stored.jobs).toHaveLength(10);
  });

  it("rejects an invalid complete definition before replacing the file", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-cli-invalid-"));
    const original = JSON.stringify({ version: 3, jobs: [] });
    await writeFile(join(stateDir, "jobs.json"), original);
    await expect(applyJobsRequest({ operation: "upsert", job: {
      id: "invalid", type: "cron", target: "isaac", schedule: "not cron", prompt: "Synthetic",
    } }, { stateDir, validateReload: false })).rejects.toThrow(/schedule/);
    expect(await readFile(join(stateDir, "jobs.json"), "utf8")).toBe(original);
  });

  it("does not treat unrelated state writes as acceptance or roll back an unacknowledged edit", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-cli-ack-"));
    // A future mtime cannot acknowledge a generation the host has not observed.
    await writeFile(join(stateDir, "jobs-state.json"), JSON.stringify({
      fired: {}, lastLoadError: null, acceptedHash: "old", observedHash: "old",
    }));
    const result = await applyJobsRequest({
      operation: "add_at", id: "new", target: "isaac", in: "1h", prompt: "Synthetic",
    }, { stateDir, reloadTimeoutMs: 30 });
    expect(result).toMatchObject({ ok: true, publication: { status: "pending" } });
    expect(JSON.parse(await readFile(join(stateDir, "jobs.json"), "utf8")).jobs).toHaveLength(1);
  });

  it("resolves the fleet coordinator from the private instance manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobs-cli-fleet-"));
    const manifestPath = join(root, "instances.json");
    await writeFile(manifestPath, JSON.stringify({
      instances: [
        { id: "isaac", jobsRole: "coordinator" },
        { id: "builder", jobsRole: "target-only" },
      ],
    }));

    await expect(resolveCoordinatorStateDir({
      PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST: manifestPath,
      PI_TELEGRAM_BRIDGE_STATE_ROOT: root,
    })).resolves.toBe(join(root, "instances", "isaac"));
  });

  it("adds relative reminders, prunes fired reminders, and writes schema 3 atomically", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-cli-add-"));
    await writeFile(join(stateDir, "jobs.json"), JSON.stringify({
      version: 3,
      jobs: [
        { id: "old", type: "at", target: "isaac", at: "2026-01-01T00:00:00Z", prompt: "old" },
        { id: "daily", type: "cron", target: "isaac", schedule: "0 8 * * *", tz: "America/Denver", prompt: "brief" },
      ],
    }));
    await writeFile(join(stateDir, "jobs-state.json"), JSON.stringify({
      fired: { old: Date.parse("2026-01-01T00:00:00Z") }, lastRun: {}, lastLoadError: null,
    }));

    const result = await applyJobsRequest({
      operation: "add_at",
      id: "follow-up",
      target: "builder",
      in: "45m",
      prompt: "Follow up",
    }, { stateDir, now: () => Date.parse("2026-07-27T03:00:00Z"), validateReload: false });

    expect(result).toMatchObject({ ok: true, operation: "add_at", pruned: ["old"] });
    const stored = JSON.parse(await readFile(join(stateDir, "jobs.json"), "utf8"));
    expect(stored).toEqual({ version: 3, publicationId: expect.any(String), jobs: [
      { id: "daily", type: "cron", target: "isaac", schedule: "0 8 * * *", tz: "America/Denver", prompt: "brief" },
      { id: "follow-up", type: "at", target: "builder", at: "2026-07-27T03:45:00.000Z", prompt: "Follow up" },
    ] });
  });

  it("upserts any job type and removes jobs through one structured interface", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-cli-upsert-"));
    await mkdir(stateDir, { recursive: true });

    await applyJobsRequest({
      operation: "upsert",
      job: { id: "weekly", type: "cron", target: "builder", schedule: "0 9 * * 1", tz: "America/Denver", prompt: "Review" },
    }, { stateDir, validateReload: false });
    const removed = await applyJobsRequest(
      { operation: "remove", id: "weekly" },
      { stateDir, validateReload: false },
    );

    expect(removed).toMatchObject({ ok: true, removed: "weekly" });
    expect(JSON.parse(await readFile(join(stateDir, "jobs.json"), "utf8")))
      .toEqual({ version: 3, publicationId: expect.any(String), jobs: [] });
  });
});
