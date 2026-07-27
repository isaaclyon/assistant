import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyJobsRequest,
  resolveCoordinatorStateDir,
} from "../.pi/skills/manage-jobs/scripts/jobs-cli.mjs";

describe("manage-jobs helper", () => {
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
    expect(stored).toEqual({ version: 3, jobs: [
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
      .toEqual({ version: 3, jobs: [] });
  });
});
