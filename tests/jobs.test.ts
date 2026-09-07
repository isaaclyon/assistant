import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveHeartbeatCheckerPath } from "../src/heartbeat.js";
import {
  type JobScheduler,
  type JobSchedulerOptions,
  parseJobsFile,
  startJobScheduler,
} from "../src/jobs.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function jobsFile(jobs: unknown[]): string {
  return `${JSON.stringify({ version: 2, jobs }, null, 2)}\n`;
}

function heartbeatJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hb",
    type: "heartbeat",
    schedule: "0 * * * *",
    tz: "UTC",
    checker: { id: "price-watch" },
    rule: { type: "changed" },
    onTrigger: { type: "prompt", prompt: "Review it" },
    ...overrides,
  };
}

function observation(value: unknown, display?: string): string {
  return JSON.stringify({ version: 1, value, ...(display === undefined ? {} : { display }) });
}

describe("parseJobsFile", () => {
  it("resolves checker IDs beside the running immutable-release module", () => {
    expect(
      resolveHeartbeatCheckerPath(
        "product-price",
        "file:///srv/releases/abc/dist/src/heartbeat.js",
      ),
    ).toBe("/srv/releases/abc/dist/src/checkers/product-price.js");
  });

  it("accepts every job type", () => {
    const jobs = parseJobsFile(
      jobsFile([
        { id: "brief", type: "cron", schedule: "0 8 * * *", tz: "America/Denver", prompt: "p" },
        { id: "once", type: "at", at: "2026-07-18T15:00:00-06:00", prompt: "p" },
        heartbeatJob(),
        { id: "hook", type: "webhook", hmacSecret: "s", prompt: "p" },
      ]),
    );
    expect(jobs.map((job) => job.type)).toEqual(["cron", "at", "heartbeat", "webhook"]);
  });

  it("requires and validates explicit version-3 instance targets", () => {
    const jobs = parseJobsFile(
      JSON.stringify({
        version: 3,
        jobs: [
          {
            id: "isaac-brief",
            type: "cron",
            schedule: "0 8 * * *",
            prompt: "p",
            target: "isaac",
          },
          {
            id: "shared-hook",
            type: "webhook",
            prompt: "p",
            target: "shared",
          },
          {
            id: "couple-reminder",
            type: "at",
            at: "2026-07-18T15:00:00Z",
            prompt: "p",
            target: "both-personal",
          },
        ],
      }),
      { validTargets: new Set(["isaac", "emma", "shared", "builder"]) },
    );

    expect(jobs.map((job) => job.target)).toEqual([
      "isaac",
      "shared",
      "both-personal",
    ]);
  });

  it("rejects missing, unknown, retired, or unavailable fan-out targets", () => {
    const parse = (target?: string, validTargets = new Set(["isaac", "shared"])) =>
      parseJobsFile(
        JSON.stringify({
          version: 3,
          jobs: [
            {
              id: "brief",
              type: "cron",
              schedule: "0 8 * * *",
              prompt: "p",
              ...(target === undefined ? {} : { target }),
            },
          ],
        }),
        { validTargets },
      );

    expect(() => parse()).toThrow(/target.*required/i);
    expect(() => parse("retired")).toThrow(/unknown target.*retired/i);
    expect(() => parse("both-personal")).toThrow(/requires configured targets isaac and emma/i);
  });

  it("maps a legacy targetless file to Isaac only when compatibility is explicit", () => {
    const raw = jobsFile([
      { id: "brief", type: "cron", schedule: "0 8 * * *", prompt: "p" },
    ]);

    expect(() =>
      parseJobsFile(raw, {
        validTargets: new Set(["isaac", "emma"]),
        requireTargets: true,
      }),
    ).toThrow(/migrate.*target.*isaac/i);
    expect(
      parseJobsFile(raw, {
        validTargets: new Set(["isaac", "emma"]),
        requireTargets: true,
        compatibilityTarget: "isaac",
      })[0]?.target,
    ).toBe("isaac");
  });

  it("rejects invalid JSON, versions, and shapes", () => {
    expect(() => parseJobsFile("{nope")).toThrow(/not valid JSON/);
    expect(() => parseJobsFile('{"version":4,"jobs":[]}')).toThrow(/"version": 2 or 3/);
    expect(() => parseJobsFile('{"version":2}')).toThrow(/"jobs" array/);
  });

  it("reads version-1 jobs that do not use legacy heartbeat shell commands", () => {
    const jobs = parseJobsFile(
      JSON.stringify({
        version: 1,
        jobs: [
          { id: "brief", type: "cron", schedule: "0 8 * * *", prompt: "p" },
          { id: "once", type: "at", at: "2026-07-18T15:00:00Z", prompt: "p" },
          { id: "hook", type: "webhook", prompt: "p" },
        ],
      }),
    );
    expect(jobs.map((job) => job.type)).toEqual(["cron", "at", "webhook"]);
  });

  it("rejects version-1 heartbeat jobs with an actionable migration error", () => {
    expect(() =>
      parseJobsFile(
        JSON.stringify({
          version: 1,
          jobs: [
            {
              id: "legacy-watch",
              type: "heartbeat",
              schedule: "0 * * * *",
              check: "legacy.sh",
              prompt: "p",
            },
          ],
        }),
      ),
    ).toThrow(/legacy heartbeat jobs.*legacy-watch.*must be migrated/i);
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
          heartbeatJob({ id: "no-check", checker: undefined }),
          heartbeatJob({ id: "shell-check", checker: { command: "touch /tmp/not-allowed" } }),
          heartbeatJob({ id: "bad-rule", rule: { type: "condition", operator: "less-than", target: 0, for: "soon", notify: "once-per-episode" } }),
          heartbeatJob({ id: "bad-action", onTrigger: { type: "command", prompt: "p" } }),
          { id: "no-prompt", type: "cron", schedule: "0 8 * * *", prompt: "" },
          { id: "bad-type", type: "monthly", prompt: "p" },
        ]),
      );
    expect(invalid).toThrow(/"id" must match/);
    expect(invalid).toThrow(/duplicate id "dup"/);
    expect(invalid).toThrow(/bad-cron.*invalid schedule/);
    expect(invalid).toThrow(/bad-at.*parseable timestamp/);
    expect(invalid).toThrow(/no-check.*"checker"/);
    expect(invalid).toThrow(/shell-check.*"checker.id"/);
    expect(invalid).toThrow(/bad-rule.*"for"/);
    expect(invalid).toThrow(/bad-action.*"onTrigger"/);
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

  it("carries the validated target into scheduled prompt dispatch", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "jobs-target-dispatch-"));
    const inject = vi.fn(async () => {});
    const now = Date.parse("2026-07-18T16:00:00Z");
    await writeFile(
      join(stateDir, "jobs.json"),
      JSON.stringify({
        version: 3,
        jobs: [
          {
            id: "emma-reminder",
            type: "at",
            at: "2026-07-18T15:00:00Z",
            prompt: "Call the dentist",
            target: "emma",
          },
        ],
      }),
    );
    scheduler = await startJobScheduler({
      stateDir,
      webhookHost: "127.0.0.1",
      webhookPort: 0,
      inject,
      logger: silentLogger,
      nowMs: () => now,
      tickIntervalMs: 60_000,
      validTargets: new Set(["isaac", "emma", "shared"]),
      requireTargets: true,
    });

    await scheduler.tick();

    expect(inject).toHaveBeenCalledWith(
      expect.stringContaining("Call the dentist"),
      {
        jobId: "emma-reminder",
        jobType: "at",
        target: "emma",
        eventId: `at:emma-reminder:${Date.parse("2026-07-18T15:00:00Z")}`,
        occurrenceId: expect.stringMatching(/^emma-reminder-[a-f0-9]{64}$/),
        definitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    );
  });

  async function writeJobs(stateDir: string, jobs: unknown[]): Promise<void> {
    const temporary = join(stateDir, "jobs.json.tmp");
    await writeFile(temporary, jobsFile(jobs), "utf8");
    await rename(temporary, join(stateDir, "jobs.json"));
  }

  it("recovers a materialized cron occurrence across restart without replaying missed cron slots", async () => {
    const { stateDir, inject, now } = await makeScheduler();
    await writeJobs(stateDir, [{ id: "brief", type: "cron", schedule: "0 * * * *", tz: "UTC", prompt: "Synthetic" }]);
    await scheduler!.reload();
    inject.mockRejectedValue(new Error("recipient publication unavailable"));
    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    const originalDispatch = inject.mock.calls[0]![1];
    await scheduler!.stop();
    now.ms = Date.parse("2026-07-18T14:00:05Z");
    const recovered = vi.fn(async () => {});
    scheduler = await startJobScheduler({
      stateDir, inject: recovered, webhookHost: "127.0.0.1", webhookPort: 0,
      logger: silentLogger, nowMs: () => now.ms, tickIntervalMs: 3_600_000,
    });
    await scheduler.tick();
    expect(recovered).toHaveBeenCalledExactlyOnceWith(expect.any(String), originalDispatch);
  });

  it("gives an edited one-shot definition a new occurrence rather than inheriting fired state", async () => {
    const { stateDir, inject } = await makeScheduler();
    const job = { id: "once", type: "at", at: "2026-07-18T09:00:00Z", prompt: "First" };
    await writeJobs(stateDir, [job]);
    await scheduler!.reload();
    await scheduler!.tick();
    await writeJobs(stateDir, [{ ...job, prompt: "Second" }]);
    await scheduler!.reload();
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(2);
    expect(inject.mock.calls[1]![0]).toContain("Second");
    expect(inject.mock.calls[1]![1].occurrenceId).not.toBe(inject.mock.calls[0]![1].occurrenceId);
  });

  it("waits for in-flight publication on shutdown", async () => {
    const { stateDir, inject } = await makeScheduler();
    await writeJobs(stateDir, [{ id: "once", type: "at", at: "2026-07-18T09:00:00Z", prompt: "Synthetic" }]);
    await scheduler!.reload();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    inject.mockImplementation(() => gate);
    const ticking = scheduler!.tick();
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = scheduler!.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stoppedEarly = stopped;
    release();
    await Promise.all([ticking, stopping]);
    expect(stoppedEarly).toBe(false);
  });

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

  it("preserves an unchanged job's due occurrence across an unrelated reload", async () => {
    const { stateDir, inject, now } = await makeScheduler();
    const job = { id: "brief", type: "cron", schedule: "0 11 * * *", tz: "UTC", prompt: "Morning brief" };
    await writeJobs(stateDir, [job]);
    await scheduler!.reload();
    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await writeJobs(stateDir, [job, { id: "later", type: "at", at: "2027-01-01T00:00:00Z", prompt: "Later" }]);
    await scheduler!.reload();
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("records exact observed and accepted content identities", async () => {
    const { stateDir } = await makeScheduler();
    const raw = jobsFile([{ id: "brief", type: "cron", schedule: "0 11 * * *", prompt: "p" }]);
    await writeFile(join(stateDir, "jobs.json"), raw);
    await scheduler!.reload();
    const accepted = JSON.parse(await readFile(join(stateDir, "jobs-state.json"), "utf8"));
    expect(accepted.acceptedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted.observedHash).toBe(accepted.acceptedHash);
    await writeFile(join(stateDir, "jobs.json"), "invalid");
    await scheduler!.reload();
    const rejected = JSON.parse(await readFile(join(stateDir, "jobs-state.json"), "utf8"));
    expect(rejected.observedHash).not.toBe(accepted.observedHash);
    expect(rejected.acceptedHash).toBe(accepted.acceptedHash);
    expect(rejected.lastLoadError).toBeTypeOf("string");
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

  it("silently establishes a heartbeat baseline and triggers once when it changes", async () => {
    const runCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, stdout: observation(19.99, "$19.99") })
      .mockResolvedValueOnce({ ok: true, stdout: observation(24.99, "$24.99") })
      .mockResolvedValueOnce({ ok: true, stdout: observation(24.99, "$24.99") });
    const { stateDir, inject, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [heartbeatJob()]);
    await scheduler!.reload();

    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();
    expect(runCheck).toHaveBeenCalledWith("price-watch", expect.any(Number));
    expect(inject).not.toHaveBeenCalled();

    now.ms = Date.parse("2026-07-18T12:00:05Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    const prompt = inject.mock.calls[0]?.[0];
    expect(prompt).toContain("Review it");
    expect(prompt).toContain('"previousValue": 19.99');
    expect(prompt).toContain('"currentValue": 24.99');

    now.ms = Date.parse("2026-07-18T13:00:05Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("does not replace a good heartbeat baseline when a check fails", async () => {
    const runCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, stdout: observation(10) })
      .mockResolvedValueOnce({ ok: false, stdout: "" })
      .mockResolvedValueOnce({ ok: true, stdout: "not json" })
      .mockResolvedValueOnce({ ok: true, stdout: "x".repeat(4 * 1024 + 1) })
      .mockResolvedValueOnce({ ok: true, stdout: observation(10) });
    const { stateDir, inject, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [heartbeatJob()]);
    await scheduler!.reload();

    for (const hour of [11, 12, 13, 14, 15]) {
      now.ms = Date.parse(`2026-07-18T${hour}:00:05Z`);
      await scheduler!.tick();
    }

    expect(inject).not.toHaveBeenCalled();
    const state = JSON.parse(
      await readFile(join(stateDir, "checkers", "hb.json"), "utf8"),
    );
    expect(state.lastObservation.value).toBe(10);
    expect(state.lastFailureAt).toBe(Date.parse("2026-07-18T14:00:05Z"));
    expect(state.lastSuccessfulObservationAt).toBe(Date.parse("2026-07-18T15:00:05Z"));
  });

  it("triggers once per sustained condition episode", async () => {
    const runCheck = vi.fn(async () => ({ ok: true, stdout: observation(-12500, "-$125.00") }));
    const { stateDir, inject, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [
      heartbeatJob({
        rule: {
          type: "condition",
          operator: "less-than",
          target: 0,
          for: "15d",
          notify: "once-per-episode",
        },
      }),
    ]);
    await scheduler!.reload();

    const firstObserved = Date.parse("2026-07-18T11:00:05Z");
    now.ms = firstObserved;
    await scheduler!.tick();
    runCheck.mockResolvedValueOnce({ ok: false, stdout: "" });
    now.ms = firstObserved + 14 * 24 * 60 * 60 * 1000;
    await scheduler!.tick();
    expect(inject).not.toHaveBeenCalled();

    now.ms = firstObserved + 15 * 24 * 60 * 60 * 1000;
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toContain('"conditionSince"');

    now.ms = firstObserved + 16 * 24 * 60 * 60 * 1000;
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);

    runCheck.mockResolvedValueOnce({ ok: true, stdout: observation(1) });
    now.ms = firstObserved + 17 * 24 * 60 * 60 * 1000;
    await scheduler!.tick();
    runCheck.mockResolvedValue({ ok: true, stdout: observation(-1) });
    now.ms = firstObserved + 18 * 24 * 60 * 60 * 1000;
    await scheduler!.tick();
    now.ms = firstObserved + 33 * 24 * 60 * 60 * 1000;
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it("starts a new baseline when a heartbeat checker configuration changes", async () => {
    const runCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, stdout: observation(10) })
      .mockResolvedValueOnce({ ok: true, stdout: observation(11) });
    const { stateDir, inject, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [heartbeatJob()]);
    await scheduler!.reload();
    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();

    await writeJobs(stateDir, [
      heartbeatJob({ checker: { id: "replacement-check" } }),
    ]);
    await scheduler!.reload();
    now.ms = Date.parse("2026-07-18T12:00:05Z");
    await scheduler!.tick();

    expect(runCheck).toHaveBeenLastCalledWith("replacement-check", expect.any(Number));
    expect(inject).not.toHaveBeenCalled();
  });

  it("persists and retries a changed event after restart before another observation", async () => {
    const runCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, stdout: observation(10) })
      .mockResolvedValueOnce({ ok: true, stdout: observation(12) });
    const { stateDir, inject, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [heartbeatJob()]);
    await scheduler!.reload();

    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();
    inject.mockRejectedValueOnce(new Error("Agent is already processing"));
    now.ms = Date.parse("2026-07-18T12:00:05Z");
    await scheduler!.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(runCheck).toHaveBeenCalledTimes(2);

    let state = JSON.parse(await readFile(join(stateDir, "checkers", "hb.json"), "utf8"));
    expect(state.pendingEvent).not.toBeNull();

    await scheduler!.stop();
    const retryInject = vi.fn(async (_prompt: string) => {});
    scheduler = await startJobScheduler({
      stateDir,
      webhookHost: "127.0.0.1",
      webhookPort: 0,
      inject: retryInject,
      logger: silentLogger,
      nowMs: () => now.ms,
      tickIntervalMs: 3_600_000,
      runCheck,
    });
    now.ms = Date.parse("2026-07-18T13:00:05Z");
    await scheduler!.tick();
    expect(retryInject).toHaveBeenCalledTimes(1);
    expect(runCheck).toHaveBeenCalledTimes(2);
    state = JSON.parse(await readFile(join(stateDir, "checkers", "hb.json"), "utf8"));
    expect(state.pendingEvent).toBeNull();
  });

  it("loads heartbeat observation state after a scheduler restart", async () => {
    const runCheck = vi
      .fn(async (_command: string, _timeoutMs: number) => ({
        ok: true,
        stdout: observation(11),
      }))
      .mockResolvedValueOnce({ ok: true, stdout: observation(10) })
      .mockResolvedValueOnce({ ok: true, stdout: observation(11) });
    const { stateDir, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [heartbeatJob()]);
    await scheduler!.reload();
    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();
    await scheduler!.stop();

    const inject = vi.fn(async (_prompt: string) => {});
    scheduler = await startJobScheduler({
      stateDir,
      webhookHost: "127.0.0.1",
      webhookPort: 0,
      inject,
      logger: silentLogger,
      nowMs: () => now.ms,
      tickIntervalMs: 3_600_000,
      runCheck,
    });
    now.ms = Date.parse("2026-07-18T12:00:05Z");
    await scheduler.tick();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0]?.[0]).toContain('"previousValue": 10');
  });

  it("prunes state when a heartbeat job is removed", async () => {
    const runCheck = vi.fn(async () => ({ ok: true, stdout: observation(10) }));
    const { stateDir, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [heartbeatJob()]);
    await scheduler!.reload();
    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();
    expect(await readFile(join(stateDir, "checkers", "hb.json"), "utf8")).toContain(
      '"value": 10',
    );

    await writeJobs(stateDir, []);
    await scheduler!.reload();
    await expect(readFile(join(stateDir, "checkers", "hb.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not persist or inject an in-flight heartbeat removed by reload", async () => {
    let checkCount = 0;
    let markSecondCheckStarted: (() => void) | undefined;
    const secondCheckStarted = new Promise<void>((resolve) => {
      markSecondCheckStarted = resolve;
    });
    let resolveSecondCheck: ((result: { ok: boolean; stdout: string }) => void) | undefined;
    const secondCheck = new Promise<{ ok: boolean; stdout: string }>((resolve) => {
      resolveSecondCheck = resolve;
    });
    const runCheck = vi.fn(async (_checkerId: string, _timeoutMs: number) => {
      checkCount += 1;
      if (checkCount === 1) return { ok: true, stdout: observation(10) };
      markSecondCheckStarted?.();
      return secondCheck;
    });
    const { stateDir, inject, now } = await makeScheduler({ runCheck });
    await writeJobs(stateDir, [heartbeatJob()]);
    await scheduler!.reload();
    now.ms = Date.parse("2026-07-18T11:00:05Z");
    await scheduler!.tick();

    now.ms = Date.parse("2026-07-18T12:00:05Z");
    const tick = scheduler!.tick();
    await secondCheckStarted;
    await writeJobs(stateDir, []);
    const reload = scheduler!.reload();
    resolveSecondCheck?.({ ok: true, stdout: observation(11) });
    await Promise.all([tick, reload]);

    expect(inject).not.toHaveBeenCalled();
    await expect(readFile(join(stateDir, "checkers", "hb.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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
