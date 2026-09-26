import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  drainJobHandoffs,
  enqueueJobHandoff,
  cancelJobHandoff,
  inspectUnresolvedJobHandoffs,
  jobHandoffLocation,
  recoverJobHandoff,
} from "../src/job-handoff.js";
import { definitionFingerprint } from "../src/job-occurrences.js";

describe("durable instance job handoff", () => {
  it("resolves singleton and fleet handoff locations from the host config", () => {
    expect(jobHandoffLocation({ stateDir: "/state" }, "isaac")).toEqual({
      stateRoot: "/state", coordinatorStateDir: "/state", local: true, target: "local",
    });
    const fleet = { stateDir: "/root/instances/isaac", stateRoot: "/root", instanceId: "isaac" };
    expect(jobHandoffLocation(fleet, "both-personal")).toEqual({
      stateRoot: "/root", coordinatorStateDir: "/root/instances/isaac", local: false, target: "both-personal",
    });
    expect(() => jobHandoffLocation(fleet, undefined)).toThrow("Fleet job target is required");
  });

  it.each([true, false])("finishes at durable preflight=%s even if the run never settles", async (accepted) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-preflight-return-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    await enqueueJobHandoff({
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Synthetic",
    });
    let result: unknown;
    void drainJobHandoffs({
      stateDir, instanceId: "isaac", inject: async (_prompt, _type, preflight) => {
        preflight(accepted);
        await new Promise<void>(() => {});
      },
    }).then((value) => { result = value; });
    await vi.waitFor(() => expect(result).toEqual({ processed: accepted ? 1 : 0, failed: accepted ? 0 : 1, uncertain: 0 }));
  });

  it("requires exact recipient evidence for explicit uncertain-work recovery", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-recovery-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    await enqueueJobHandoff({
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Private synthetic wording",
    });
    await drainJobHandoffs({ stateDir, instanceId: "isaac", inject: async () => { throw new Error("uncertain"); } });
    const inspection = await inspectUnresolvedJobHandoffs({ stateDir, instanceId: "isaac" });
    expect(JSON.stringify(inspection)).not.toContain("Private synthetic wording");
    expect(inspection.entries).toHaveLength(1);
    const entry = inspection.entries[0]!;
    await expect(recoverJobHandoff({ stateDir, instanceId: "emma", ...entry, action: "retry" })).rejects.toThrow();
    await expect(recoverJobHandoff({ stateDir, instanceId: "isaac", ...entry, revision: "0".repeat(64), action: "retry" })).rejects.toThrow(/changed/);
    await recoverJobHandoff({ stateDir, instanceId: "isaac", ...entry, action: "retry" });
    const inject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => { preflight(true); });
    expect(await drainJobHandoffs({ stateDir, instanceId: "isaac", inject })).toEqual({ processed: 1, failed: 0, uncertain: 0 });
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("records operator acknowledgement separately from observed Pi acceptance", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-acknowledge-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    await enqueueJobHandoff({
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Synthetic",
    });
    await drainJobHandoffs({ stateDir, instanceId: "isaac", inject: async () => {} });
    const entry = (await inspectUnresolvedJobHandoffs({ stateDir, instanceId: "isaac" })).entries[0]!;
    await recoverJobHandoff({ stateDir, instanceId: "isaac", ...entry, action: "acknowledge" });
    expect(await readdir(join(stateDir, "job-handoffs", "acknowledged"))).toHaveLength(1);
    expect(await readdir(join(stateDir, "job-handoffs", "completed"))).toHaveLength(0);
  });

  it("separates identical events from different definitions and cancels only unclaimed recipients", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-definitions-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    const base = { stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test", target: "isaac" };
    const first = await enqueueJobHandoff({ ...base, prompt: "First",
      definitionFingerprint: definitionFingerprint({ id: "test", type: "webhook", prompt: "First" }) });
    const next = await enqueueJobHandoff({ ...base, prompt: "Second",
      definitionFingerprint: definitionFingerprint({ id: "test", type: "webhook", prompt: "Second" }) });
    expect(first.dispatchId).not.toBe(next.dispatchId);
    await cancelJobHandoff({ ...base, dispatchId: first.dispatchId });
    const inject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => { preflight(true); });
    await drainJobHandoffs({ stateDir, instanceId: "isaac", inject });
    expect(inject).toHaveBeenCalledExactlyOnceWith("Second", undefined, expect.any(Function));
    expect(await cancelJobHandoff({ ...base, dispatchId: next.dispatchId })).toEqual({ isaac: "completed" });
    // Cancellation ahead of a delayed publication remains a terminal tombstone.
    await enqueueJobHandoff({ ...base, prompt: "First",
      definitionFingerprint: definitionFingerprint({ id: "test", type: "webhook", prompt: "First" }) });
    expect(await readdir(join(stateDir, "job-handoffs", "pending"))).toHaveLength(0);
  });

  it("uses the same durable recipient protocol for a singleton host", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "bridge-job-local-"));
    await enqueueJobHandoff({
      stateRoot: stateDir, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "local", local: true, prompt: "Singleton prompt",
    });
    const inject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => { preflight(true); });
    expect(await drainJobHandoffs({ stateDir, instanceId: "local", inject })).toEqual({ processed: 1, failed: 0, uncertain: 0 });
  });

  it("reconciles terminal recipient evidence when the coordinator acknowledgement lags", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-reconcile-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    const options = {
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Synthetic prompt",
    };
    const first = await enqueueJobHandoff(options);
    const inject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => { preflight(true); });
    await drainJobHandoffs({ stateDir, instanceId: "isaac", inject });
    const statusPath = join(stateDir, "job-dispatches", `${first.dispatchId}.json`);
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    status.recipients.isaac = "pending";
    await writeFile(statusPath, JSON.stringify(status));
    await enqueueJobHandoff(options);
    await drainJobHandoffs({ stateDir, instanceId: "isaac", inject });
    expect(inject).toHaveBeenCalledTimes(1);
    expect(await readdir(join(stateDir, "job-handoffs", "pending"))).toHaveLength(0);
  });

  it.each(["throw", "resolve"] as const)("leaves an invocation without preflight evidence uncertain when it %ss", async (outcome) => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-uncertain-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    await enqueueJobHandoff({
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Synthetic prompt",
    });
    const inject = vi.fn(async () => { if (outcome === "throw") throw new Error("already processing, but acceptance unknown"); });
    expect(await drainJobHandoffs({ stateDir, instanceId: "isaac", inject }))
      .toEqual({ processed: 0, failed: 0, uncertain: 1 });
    expect(await drainJobHandoffs({ stateDir, instanceId: "isaac", inject }))
      .toEqual({ processed: 0, failed: 0, uncertain: 1 });
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("persists acceptance before the full run settles and never retries a post-acceptance error", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-accepted-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    await enqueueJobHandoff({
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Synthetic prompt",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => {
      preflight(true);
      await gate;
      throw new Error("run failed after acceptance");
    });
    const draining = drainJobHandoffs({ stateDir, instanceId: "isaac", inject });
    await vi.waitFor(async () => expect(await readdir(join(stateDir, "job-handoffs", "completed"))).toHaveLength(1));
    release();
    expect(await draining).toEqual({ processed: 1, failed: 0, uncertain: 0 });
    expect(await drainJobHandoffs({ stateDir, instanceId: "isaac", inject }))
      .toEqual({ processed: 0, failed: 0, uncertain: 0 });
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("retries only explicit preflight rejection, with a durable five-attempt bound", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-rejected-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    await enqueueJobHandoff({
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Synthetic prompt",
    });
    const inject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => {
      preflight(false);
      throw new Error("known rejection");
    });
    for (let attempt = 0; attempt < 6; attempt++) {
      await drainJobHandoffs({ stateDir, instanceId: "isaac", inject });
    }
    expect(inject).toHaveBeenCalledTimes(5);
    expect(await readdir(join(stateDir, "job-handoffs", "pending"))).toHaveLength(0);
    expect(await readdir(join(stateDir, "job-handoffs", "failed"))).toHaveLength(1);
  });

  it("persists known rejection even while the invocation promise remains unresolved", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-rejection-boundary-"));
    const stateDir = join(stateRoot, "instances", "isaac");
    await enqueueJobHandoff({
      stateRoot, coordinatorStateDir: stateDir, eventId: "synthetic", jobId: "test",
      target: "isaac", prompt: "Synthetic prompt",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let observed = false;
    const draining = drainJobHandoffs({
      stateDir, instanceId: "isaac",
      inject: async (_prompt, _type, preflight) => {
        preflight(false);
        observed = true;
        await gate;
      },
    });
    try {
      await vi.waitFor(async () => {
        expect(observed).toBe(true);
        expect(await readdir(join(stateDir, "job-handoffs", "pending"))).toHaveLength(1);
        expect(await readdir(join(stateDir, "job-handoffs", "processing"))).toHaveLength(0);
      });
    } finally {
      release();
      await draining;
    }
  });

  it("fans out to Isaac and Emma independently and each target consumes only its own prompt", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-handoff-"));
    const coordinatorStateDir = join(stateRoot, "instances", "isaac");
    await mkdir(coordinatorStateDir, { recursive: true });

    const result = await enqueueJobHandoff({
      stateRoot,
      coordinatorStateDir,
      eventId: "at:couple-reminder:2026-07-21T18:00:00Z",
      jobId: "couple-reminder",
      jobType: "at",
      target: "both-personal",
      prompt: "Remember the appointment",
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });

    expect(result.recipients).toEqual({ isaac: "enqueued", emma: "enqueued" });
    const isaacInject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => { preflight(true); });
    const emmaInject = vi.fn(async (_prompt: string, _type: unknown, preflight: (accepted: boolean) => void) => { preflight(true); });
    await expect(
      drainJobHandoffs({
        stateDir: join(stateRoot, "instances", "isaac"),
        instanceId: "isaac",
        inject: isaacInject,
      }),
    ).resolves.toEqual({ processed: 1, failed: 0, uncertain: 0 });
    await expect(
      drainJobHandoffs({
        stateDir: join(stateRoot, "instances", "emma"),
        instanceId: "emma",
        inject: emmaInject,
      }),
    ).resolves.toEqual({ processed: 1, failed: 0, uncertain: 0 });
    expect(isaacInject).toHaveBeenCalledWith("Remember the appointment", "at", expect.any(Function));
    expect(emmaInject).toHaveBeenCalledWith("Remember the appointment", "at", expect.any(Function));
  });

  it("retries only a fan-out recipient that was not already enqueued", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-retry-"));
    const coordinatorStateDir = join(stateRoot, "instances", "coordinator");
    await mkdir(coordinatorStateDir, { recursive: true });
    await writeFile(join(stateRoot, "instances", "emma"), "blocks directory");
    const options = {
      stateRoot,
      coordinatorStateDir,
      eventId: "cron:morning:1234",
      jobId: "morning",
      target: "both-personal",
      prompt: "Morning briefing",
    };

    await expect(enqueueJobHandoff(options)).rejects.toThrow(/emma/i);
    const isaacPending = join(
      stateRoot,
      "instances",
      "isaac",
      "job-handoffs",
      "pending",
    );
    expect(await readdir(isaacPending)).toHaveLength(1);

    await rm(join(stateRoot, "instances", "emma"));
    const retried = await enqueueJobHandoff(options);

    expect(retried.recipients).toEqual({ isaac: "enqueued", emma: "enqueued" });
    expect(await readdir(isaacPending)).toHaveLength(1);
    expect(
      await readdir(
        join(stateRoot, "instances", "emma", "job-handoffs", "pending"),
      ),
    ).toHaveLength(1);
  });

  it("quarantines a handoff whose embedded target does not own the state directory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "bridge-job-wrong-target-"));
    const pendingDir = join(stateDir, "job-handoffs", "pending");
    await mkdir(pendingDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(pendingDir, "wrong.json"),
      JSON.stringify({
        version: 1,
        dispatchId: "wrong",
        jobId: "brief",
        target: "isaac",
        prompt: "private prompt",
        createdAt: "2026-07-21T12:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    const inject = vi.fn(async () => {});

    await expect(
      drainJobHandoffs({ stateDir, instanceId: "emma", inject }),
    ).resolves.toEqual({ processed: 0, failed: 1, uncertain: 0 });
    expect(inject).not.toHaveBeenCalled();
    const quarantined = await readdir(join(stateDir, "job-handoffs", "failed"));
    expect(quarantined).toEqual(["wrong.json"]);
    expect(await readFile(join(stateDir, "job-handoffs", "failed", "wrong.json"), "utf8"))
      .toContain('"target":"isaac"');
  });
});
