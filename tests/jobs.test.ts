import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type JobScheduler,
  type JobSchedulerOptions,
  parseJobsFile,
  startJobScheduler,
} from "../src/jobs.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function jobsFile(jobs: unknown[]): string {
  return `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`;
}

describe("parseJobsFile", () => {
  it("accepts every job type", () => {
    const jobs = parseJobsFile(
      jobsFile([
        { id: "brief", type: "cron", schedule: "0 8 * * *", tz: "America/Denver", prompt: "p" },
        { id: "once", type: "at", at: "2026-07-18T15:00:00-06:00", prompt: "p" },
        { id: "hb", type: "heartbeat", schedule: "0 * * * *", check: "true", prompt: "p" },
        { id: "hook", type: "webhook", hmacSecret: "s", prompt: "p" },
      ]),
    );
    expect(jobs.map((job) => job.type)).toEqual(["cron", "at", "heartbeat", "webhook"]);
  });

  it("rejects invalid JSON, versions, and shapes", () => {
    expect(() => parseJobsFile("{nope")).toThrow(/not valid JSON/);
    expect(() => parseJobsFile('{"version":2,"jobs":[]}')).toThrow(/"version": 1/);
    expect(() => parseJobsFile('{"version":1}')).toThrow(/"jobs" array/);
  });

  it("collects per-job validation errors", () => {
    const invalid = () =>
      parseJobsFile(
        jobsFile([
          { id: "UPPER", type: "cron", schedule: "0 8 * * *", prompt: "p" },
          { id: "dup", type: "at", at: "2026-01-01T00:00:00Z", prompt: "p" },
          { id: "dup", type: "at", at: "2026-01-01T00:00:00Z", prompt: "p" },
          { id: "bad-cron", type: "cron", schedule: "not a cron", prompt: "p" },
          { id: "bad-at", type: "at", at: "whenever", prompt: "p" },
          { id: "no-check", type: "heartbeat", schedule: "0 * * * *", prompt: "p" },
          { id: "no-prompt", type: "cron", schedule: "0 8 * * *", prompt: "" },
          { id: "bad-type", type: "monthly", prompt: "p" },
        ]),
      );
    expect(invalid).toThrow(/"id" must match/);
    expect(invalid).toThrow(/duplicate id "dup"/);
    expect(invalid).toThrow(/bad-cron.*invalid schedule/);
    expect(invalid).toThrow(/bad-at.*parseable timestamp/);
    expect(invalid).toThrow(/no-check.*"check"/);
    expect(invalid).toThrow(/no-prompt.*"prompt"/);
    expect(invalid).toThrow(/bad-type.*"type"/);
  });
});

describe("startJobScheduler", () => {
  let scheduler: JobScheduler | undefined;
  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
  });

  async function makeScheduler(
    overrides: Partial<JobSchedulerOptions> = {},
  ): Promise<{ stateDir: string; inject: ReturnType<typeof vi.fn>; now: { ms: number } }> {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-test-"));
    const inject = vi.fn(async () => {});
    const now = { ms: Date.parse("2026-07-18T10:00:00Z") };
    scheduler = await startJobScheduler({
      stateDir,
      webhookHost: "127.0.0.1",
      webhookPort: 0,
      inject,
      logger: silentLogger,
      nowMs: () => now.ms,
      tickIntervalMs: 3_600_000,
      ...overrides,
    });
    return { stateDir, inject, now };
  }

  async function writeJobs(stateDir: string, jobs: unknown[]): Promise<void> {
    const temporary = join(stateDir, "jobs.json.tmp");
    await writeFile(temporary, jobsFile(jobs), "utf8");
    await rename(temporary, join(stateDir, "jobs.json"));
  }

  it("fires a cron job when its schedule elapses and not before", async () => {
    const { stateDir, inject, now } = await makeScheduler();
    await writeJobs(stateDir, [
      { id: "brief", type: "cron", schedule: "0 11 * * *", tz: "UTC", prompt: "Morning brief" },
    ]);
    await scheduler!.reload();

    await scheduler!.tick();
    expect(inject).not.toHaveBeenCalled();

    now.ms = Date.parse("2026-07-18T11:00:30Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toContain("Morning brief");
    expect(inject.mock.calls[0]?.[0]).toContain("'brief'");

    // Same occurrence does not fire twice; the next one does.
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    now.ms = Date.parse("2026-07-19T11:00:30Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it("fires an at job exactly once, even late and across reloads", async () => {
    const { stateDir, inject, now } = await makeScheduler();
    await writeJobs(stateDir, [
      { id: "once", type: "at", at: "2026-07-18T09:00:00Z", prompt: "Reminder" },
    ]);
    await scheduler!.reload();

    // Already past due (simulated downtime): fires late with the scheduled time.
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toContain("2026-07-18T09:00:00Z");

    await scheduler!.reload();
    now.ms += 60_000;
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);

    const state = JSON.parse(await readFile(join(stateDir, "jobs-state.json"), "utf8"));
    expect(state.fired.once).toBeTypeOf("number");
  });

  it("leaves an at job unfired when injection fails, so the next tick retries", async () => {
    const { stateDir, inject } = await makeScheduler();
    await writeJobs(stateDir, [
      { id: "once", type: "at", at: "2026-07-18T09:00:00Z", prompt: "Reminder" },
    ]);
    await scheduler!.reload();

    inject.mockRejectedValueOnce(new Error("Agent is already processing"));
    await scheduler!.tick();
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(2);
    inject.mockClear();
    await scheduler!.tick();
    expect(inject).not.toHaveBeenCalled();
  });

  it("runs heartbeat checks and only triggers on exit 0", async () => {
    const runCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stdout: "" })
      .mockResolvedValueOnce({ ok: true, stdout: "PR #42 merged" });
    const { stateDir, inject, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [
      { id: "hb", type: "heartbeat", schedule: "0 * * * *", tz: "UTC", check: "check.sh", prompt: "Review it" },
    ]);
    await scheduler!.reload();

    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();
    expect(runCheck).toHaveBeenCalledWith("check.sh", expect.any(Number));
    expect(inject).not.toHaveBeenCalled();

    now.ms = Date.parse("2026-07-18T12:00:05Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toContain("Review it");
    expect(inject.mock.calls[0]?.[0]).toContain("PR #42 merged");
  });

  it("keeps last-good jobs and records lastLoadError when jobs.json goes bad", async () => {
    const { stateDir, inject, now } = await makeScheduler();
    await writeJobs(stateDir, [
      { id: "brief", type: "cron", schedule: "0 11 * * *", tz: "UTC", prompt: "Morning brief" },
    ]);
    await scheduler!.reload();
    expect(scheduler!.getJobs()).toHaveLength(1);

    await writeFile(join(stateDir, "jobs.json"), "{broken", "utf8");
    await scheduler!.reload();
    expect(scheduler!.getJobs()).toHaveLength(1);
    const state = JSON.parse(await readFile(join(stateDir, "jobs-state.json"), "utf8"));
    expect(state.lastLoadError).toMatch(/not valid JSON/);

    now.ms = Date.parse("2026-07-18T11:00:30Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("starts with zero jobs when no jobs.json exists", async () => {
    const { inject } = await makeScheduler();
    expect(scheduler!.getJobs()).toHaveLength(0);
    await scheduler!.tick();
    expect(inject).not.toHaveBeenCalled();
    expect(scheduler!.webhookPort()).toBeUndefined();
  });

  it("starts and stops the webhook server as webhook jobs come and go", async () => {
    const { stateDir } = await makeScheduler();
    await writeJobs(stateDir, [{ id: "hook", type: "webhook", prompt: "p" }]);
    await scheduler!.reload();
    expect(scheduler!.webhookPort()).toBeTypeOf("number");
    const secret = await readFile(join(stateDir, "webhook-secret"), "utf8");
    expect(secret.trim()).toMatch(/^[0-9a-f]{64}$/);

    await writeJobs(stateDir, []);
    await scheduler!.reload();
    expect(scheduler!.webhookPort()).toBeUndefined();
  });
});
