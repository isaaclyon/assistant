import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type SubagentCompletion,
  type SubagentJobRunner,
  startSubagentService,
} from "../src/subagents.js";

async function tempState(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bridge-subagents-"));
}

describe("background subagent service", () => {
  it("returns immediately and runs every explicitly listed task concurrently", async () => {
    const releases: Array<() => void> = [];
    const runner: SubagentJobRunner = vi.fn<SubagentJobRunner>(
      (_job, _signal, onPartial) =>
        new Promise((resolve) => {
          onPartial("working");
          releases.push(() => resolve({ output: "done" }));
        }),
    );
    const service = await startSubagentService({
      stateDir: await tempState(),
      runner,
      injectCompletion: vi.fn(async () => {}),
    });

    const launched = await service.launch({
      tasks: [{ task: "one" }, { task: "two" }, { task: "three" }],
      origin: { chatId: 7, threadId: 42 },
    });

    expect(launched.jobIds).toHaveLength(3);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(3));
    expect(service.list({ status: "active" })).toHaveLength(3);
    for (const release of releases) release();
    await service.waitForIdle();
    await service.stop();
  });

  it("emits one completion event for a partially failed batch", async () => {
    const injectCompletion = vi.fn<(completion: SubagentCompletion) => Promise<void>>(async () => {});
    const service = await startSubagentService({
      stateDir: await tempState(),
      runner: async (job) => {
        if (job.task === "bad") throw new Error("provider failed");
        return { output: "good report" };
      },
      injectCompletion,
    });
    const batch = await service.launch({
      tasks: [{ task: "good" }, { task: "bad" }],
      origin: { chatId: 7 },
    });

    await service.waitForIdle();
    expect(injectCompletion).toHaveBeenCalledTimes(1);
    expect(injectCompletion.mock.calls[0]?.[0]).toMatchObject({
      batchId: batch.batchId,
      origin: { chatId: 7 },
    });
    expect(service.collect({ batchId: batch.batchId }).jobs.map((job) => job.status))
      .toEqual(["succeeded", "failed"]);
    await service.stop();
  });

  it("cancels running work and records a truthful terminal status", async () => {
    const service = await startSubagentService({
      stateDir: await tempState(),
      runner: (_job, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      injectCompletion: vi.fn(async () => {}),
    });
    const launched = await service.launch({ tasks: [{ task: "wait" }] });
    await service.cancel({ jobId: launched.jobIds[0]! });
    await service.waitForIdle();
    expect(service.inspect(launched.jobIds[0]!).status).toBe("cancelled");
    await service.stop();
  });

  it("times out work and bounds partial and final output", async () => {
    const service = await startSubagentService({
      stateDir: await tempState(),
      timeoutMs: 10,
      outputLimitBytes: 32,
      runner: (_job, signal, onPartial) =>
        new Promise((_resolve, reject) => {
          onPartial("p".repeat(200));
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      injectCompletion: vi.fn(async () => {}),
    });
    const launched = await service.launch({ tasks: [{ task: "slow" }] });
    await service.waitForIdle();
    const job = service.inspect(launched.jobIds[0]!);
    expect(job.status).toBe("timed_out");
    expect(Buffer.byteLength(job.partialOutput ?? "")).toBeLessThanOrEqual(32);
    await service.stop();
  });

  it("marks restart-interrupted jobs terminal and never retries an uncertain event", async () => {
    const stateDir = await tempState();
    const statePath = join(stateDir, "subagents", "state.json");
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(join(stateDir, "subagents"), { recursive: true }).then(() =>
        writeFile(statePath, JSON.stringify({
          version: 1,
          batches: [{
            id: "batch-1", createdAt: 1, jobIds: ["job-1"],
            completionState: "injecting", origin: { chatId: 7 },
          }],
          jobs: [{
            id: "job-1", batchId: "batch-1", task: "x", status: "running",
            model: "openai-codex/gpt-5.6-luna", thinking: "high",
            createdAt: 1, startedAt: 2,
          }],
        })),
      ),
    );
    const injectCompletion = vi.fn(async () => {});
    const service = await startSubagentService({
      stateDir,
      runner: vi.fn(async () => ({ output: "should not run" })),
      injectCompletion,
    });

    expect(service.inspect("job-1").status).toBe("interrupted");
    expect(injectCompletion).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(statePath, "utf8")).batches[0].completionState)
      .toBe("uncertain");
    await service.stop();
  });
});
