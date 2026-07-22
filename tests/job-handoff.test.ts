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
} from "../src/job-handoff.js";

describe("durable instance job handoff", () => {
  it("fans out to Isaac and Emma independently and each target consumes only its own prompt", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-job-handoff-"));
    const coordinatorStateDir = join(stateRoot, "instances", "isaac");
    await mkdir(coordinatorStateDir, { recursive: true });

    const result = await enqueueJobHandoff({
      stateRoot,
      coordinatorStateDir,
      eventId: "at:couple-reminder:2026-07-21T18:00:00Z",
      jobId: "couple-reminder",
      target: "both-personal",
      prompt: "Remember the appointment",
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });

    expect(result.recipients).toEqual({ isaac: "enqueued", emma: "enqueued" });
    const isaacInject = vi.fn(async () => {});
    const emmaInject = vi.fn(async () => {});
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
    expect(isaacInject).toHaveBeenCalledWith("Remember the appointment");
    expect(emmaInject).toHaveBeenCalledWith("Remember the appointment");
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
    await mkdir(pendingDir, { recursive: true });
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
