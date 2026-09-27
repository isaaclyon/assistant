import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  it("loads the real Pi CLI and read-only child tools with an offline provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-real-pi-"));
    temporaryDirectories.push(root);
    const resourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const extension = join(root, "offline-provider.mjs");
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(extension, `
      import child from ${JSON.stringify(pathToFileURL(join(resourceRoot, ".pi/extensions/subagents/child.ts")).href)};
      import { createAssistantMessageEventStream, getCurrentTools } from ${JSON.stringify(pathToFileURL(join(resourceRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href)};
      export default function(pi) {
        globalThis.fetch = async () => { throw new Error("Network disabled in compatibility test"); };
        child(pi);
        pi.registerProvider("compat", {
          api: "openai-completions", apiKey: "synthetic", baseUrl: "https://invalid.example",
          models: [{ id: "model", name: "Offline", reasoning: false, input: ["text"],
            contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, context) {
            const text = getCurrentTools(context.messages).map(tool => tool.name).sort().join(",");
            const message = { role: "assistant", content: [{ type: "text", text }], api: model.api,
              provider: model.provider, model: model.id, stopReason: "pending", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            message.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message });
            return stream;
          }
        });
      }
    `);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const runner = createPiSubagentRunner({ cwd: root, resourceRoot, childExtensionPath: extension });
      const result = await runner({ ...job(join(root, "sessions")), model: "compat/model" }, AbortSignal.timeout(20_000), vi.fn());
      expect(result.output).toBe("repo_image,repo_list,repo_read,repo_search,system_info,web_fetch,web_search");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 25_000);

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
