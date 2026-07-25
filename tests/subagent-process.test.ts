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
  it("uses text mode and passes only the documented child tools to Pi", async () => {
    const { root, cli } = await fakePi(`
      const index = process.argv.indexOf("--tools");
      const mode = process.argv[process.argv.indexOf("--mode") + 1];
      process.stdout.write(JSON.stringify({ mode, tools: process.argv[index + 1] }));
    `);
    const runner = createPiSubagentRunner({ cwd: root, resourceRoot: root, piCliPath: cli });

    await expect(runner(job(join(root, "session")), new AbortController().signal, vi.fn()))
      .resolves.toEqual({ output: JSON.stringify({ mode: "text", tools: "repo_read,repo_list,repo_search,repo_image,web_fetch,web_search,system_info" }) });
  });

  it("does not parse or reject large JSON-looking output as an event stream", async () => {
    const { root, cli } = await fakePi(`
      const mode = process.argv[process.argv.indexOf("--mode") + 1];
      if (mode === "json") process.stdout.write(JSON.stringify({ type: "message_update", delta: "x".repeat(5 * 1024 * 1024) }));
      else process.stdout.write("final report\\n");
    `);
    const runner = createPiSubagentRunner({ cwd: root, resourceRoot: root, piCliPath: cli });
    const onPartial = vi.fn();

    await expect(runner(job(join(root, "session")), new AbortController().signal, onPartial))
      .resolves.toEqual({ output: "final report" });
    expect(onPartial).toHaveBeenCalledWith("final report");
  });
});
