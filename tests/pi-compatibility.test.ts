import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { startBridgeHost } from "../src/host.js";
import { injectJobPrompt } from "../src/job-prompt.js";
import { buildConversationRoutingRequest } from "../src/conversation-routing.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("Pi release compatibility", () => {
  it("resumes legacy history, retries, executes a tool, compacts, and replaces a real host session offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-compatibility-"));
    const agentDir = join(root, "agent");
    const stateDir = join(root, "state");
    const sessionDir = join(stateDir, "sessions");
    const legacyFile = join(sessionDir, "2026-07-16T00-00-00-000Z_legacy.jsonl");
    const priorEnvironment = { ...process.env };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(join(root, ".pi/telegram"), { recursive: true });
    await writeFile(join(root, ".pi/telegram/AGENTS.md"), "SYNTHETIC_HOST_INSTRUCTIONS");
    await writeFile(join(root, ".pi/smoke.mjs"), `export default function(pi) {
      pi.registerTool({ name: "compat_echo", label: "Echo", description: "Synthetic compatibility tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{type: "text", text: "SYNTHETIC_TOOL_RESULT"}], details: {} }) });
      pi.on("before_agent_start", () => ({ message: {
        customType: "compat-memory", content: "SYNTHETIC_RECALLED_MEMORY", display: false } }));
      pi.on("session_before_compact", (event) => ({ compaction: {
        summary: "SYNTHETIC_COMPACTION", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore } }));
    }`);
    await writeFile(join(root, ".pi/capabilities.json"), JSON.stringify({ version: 1,
      resources: { extensions: [{ id: "compat", path: ".pi/smoke.mjs", enabled: true }], skills: [],
        instructions: [{ id: "test", path: ".pi/telegram/AGENTS.md", enabled: true }] },
      profiles: [{ id: "test", extensions: ["compat"], skills: [], instructions: "test" }],
    }));
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": {
      type: "oauth", access: "synthetic-token", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000,
    } }));
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "openai-codex", defaultModel: "gpt-6-luna",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    }));
    const oldAssistant: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "LEGACY_REPLY" }],
      api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna", usage,
      stopReason: "stop", timestamp: 1_784_160_001_000 };
    await writeFile(legacyFile, [
      { type: "session", version: 3, id: "legacy", cwd: root, timestamp: "2026-07-16T00:00:00.000Z" },
      { type: "message", id: "old-user", parentId: null, timestamp: "2026-07-16T00:00:00.000Z",
        message: { role: "user", content: "[telegram] LEGACY_QUESTION", timestamp: 1_784_160_000_000 } },
      { type: "message", id: "old-answer", parentId: "old-user", timestamp: "2026-07-16T00:00:01.000Z", message: oldAssistant },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    // Never contact a provider or Telegram while exercising production host wiring.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network disabled in compatibility test"); }));
    let host: Awaited<ReturnType<typeof startBridgeHost>> | undefined;
    try {
      host = await startBridgeHost({ config: {
        instanceId: "compat", displayName: "Compatibility", principal: "isaac", telegramProfile: "compat",
        telegramSurface: { type: "private" }, resourceRoot: root, workspaceCwd: root, capabilityProfile: "test",
        credentialScope: "isaac-personal", memoryView: "owner-and-household", jobsRole: "disabled",
        configuredInstanceIds: ["compat"], agentDir, stateRoot: root, configRoot: root, stateDir, sessionDir,
        inboxPath: join(stateDir, "inbox.db"), codexConfigPath: join(stateDir, "codex.json"),
        restartMarkerPath: join(stateDir, "restart.json"), runtimeMetadataPath: join(stateDir, "runtime.json"),
        checkerStateDir: join(stateDir, "checkers"), environmentFilePath: join(root, "instance.env"),
        webhookHost: "127.0.0.1", webhookPort: 0,
      }, logger });
      const session = host.runtime.session;
      expect(session.sessionId).toBe("legacy");
      const requests: Message[][] = [];
      let calls = 0;
      const events: string[] = [];
      session.subscribe((event) => events.push(event.type));
      session.agent.streamFunction = (_model, context) => {
        requests.push(structuredClone(context.messages));
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { ...oldAssistant, content: [], usage, timestamp: Date.now() };
        calls += 1;
        if (calls === 1) {
          message.stopReason = "error";
          message.errorMessage = "websocket_connection_limit_reached";
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          message.content = calls === 2
            ? [{ type: "toolCall", id: "compat-call", name: "compat_echo", arguments: {} }]
            : [{ type: "text", text: "SYNTHETIC_FINAL" }];
          const reason = calls === 2 ? "toolUse" : "stop";
          message.stopReason = "pending";
          stream.push({ type: "start", partial: message });
          if (reason === "stop") {
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "SYNTHETIC_FINAL", partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: "SYNTHETIC_FINAL", partial: message });
          }
          message.stopReason = reason;
          stream.push({ type: "done", reason, message });
        }
        return stream;
      };
      const accepted = vi.fn();
      await injectJobPrompt({ waitForIdle: () => session.waitForIdle(), prepare: async () => {},
        prompt: (text, options) => session.prompt(text, options) }, "[telegram] Follow up", accepted);
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      expect(calls).toBe(3);
      expect(events).toContain("auto_retry_start");
      expect(events).toContain("message_update");
      expect(events.at(-1)).toBe("agent_settled");
      expect(session.isIdle).toBe(true);
      const firstRequest = JSON.stringify(requests[0]);
      expect(firstRequest).toContain("LEGACY_QUESTION");
      expect(firstRequest).toContain("SYNTHETIC_RECALLED_MEMORY");
      expect(firstRequest).toContain("SYNTHETIC_HOST_INSTRUCTIONS");
      expect(firstRequest).toContain("exec_command");
      expect(JSON.stringify(requests[2])).toContain("SYNTHETIC_TOOL_RESULT");
      expect(session.getLastAssistantText()).toBe("SYNTHETIC_FINAL");

      await session.compact();
      await session.prompt("[telegram] After compaction", { source: "rpc" });
      const compactedRequest = JSON.stringify(requests.at(-1));
      expect(compactedRequest).toContain("SYNTHETIC_COMPACTION");
      expect(compactedRequest).toContain("SYNTHETIC_HOST_INSTRUCTIONS");
      expect(compactedRequest).toContain("exec_command");
      expect(buildConversationRoutingRequest(session.sessionManager.getBranch(), "new topic")?.state.first_user_message)
        .toBe("[telegram] LEGACY_QUESTION");
      await host.runtime.newSession();
      expect(host.runtime.session.sessionId).not.toBe("legacy");
      expect(host.runtime.session.sessionManager.getBranch().some((entry) => entry.type === "message")).toBe(false);
      expect(await readFile(legacyFile, "utf8")).toContain("LEGACY_QUESTION");
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await host?.dispose();
      vi.unstubAllGlobals();
      for (const key of Object.keys(process.env)) if (!(key in priorEnvironment)) delete process.env[key];
      Object.assign(process.env, priorEnvironment);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
