import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPiSubagentRunner } from "../src/subagent-process.js";
import type { SubagentJob } from "../src/subagents.js";

const temporaryDirectories: string[] = [];

async function fakePi(source: string): Promise<{ root: string; cli: string }> {
  const root = await mkdtemp(join(tmpdir(), "subagent-process-"));
  temporaryDirectories.push(root);
  const cli = join(root, "fake-pi.mjs");
  await writeFile(cli, source);
  return { root, cli };
}

function job(sessionDir: string): SubagentJob {
  return {
    id: "job-test",
    batchId: "batch-test",
    task: "Inspect the repository",
    model: "test/model",
    thinking: "high",
    status: "running",
    createdAt: Date.now(),
    sessionDir,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("createPiSubagentRunner", () => {
  it("allows verbose bounded intermediate events before a final report", async () => {
    const { root, cli } = await fakePi(`
      import { once } from "node:events";
      const event = JSON.stringify({ type: "message_update", delta: "x".repeat(1024) }) + "\\n";
      for (let index = 0; index < 6_000; index++) {
        if (!process.stdout.write(event)) await once(process.stdout, "drain");
      }
      process.stdout.write(JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "final report" }], stopReason: "stop" }
      }) + "\\n");
    `);
    const runner = createPiSubagentRunner({ cwd: root, resourceRoot: root, piCliPath: cli });
    const onPartial = vi.fn();

    await expect(runner(job(join(root, "session")), new AbortController().signal, onPartial))
      .resolves.toEqual({ output: "final report" });
    expect(onPartial).toHaveBeenCalledWith("final report");
  });

  it("rejects one unbounded event even below the total emergency ceiling", async () => {
    const { root, cli } = await fakePi(`
      process.stdout.write(JSON.stringify({ type: "message_update", delta: "x".repeat(5 * 1024 * 1024) }) + "\\n");
    `);
    const runner = createPiSubagentRunner({ cwd: root, resourceRoot: root, piCliPath: cli });

    await expect(runner(job(join(root, "session")), new AbortController().signal, vi.fn()))
      .rejects.toThrow("Subagent event exceeded its size limit");
  });
});
