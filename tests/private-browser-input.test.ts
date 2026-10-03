import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeInstanceConfig } from "../src/config.js";

const h = vi.hoisted(() => ({ root: "", exec: vi.fn(), spawn: vi.fn(), pageClose: vi.fn(), serverClose: vi.fn(), send: vi.fn(), done: Promise.resolve("submitted"), prepare: vi.fn(), serverOptions: undefined as any }));
vi.mock("node:util", () => ({ promisify: () => h.exec }));
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: h.spawn }));
vi.mock("../.pi/skills/agent-browser/scripts/stock-chrome.mjs", () => ({
  agentSessionName: () => "owned-agent-session", assertUnprotected: async () => {},
  current: async () => ({ launchId: "owned-launch", port: 1234 }), executable: async () => "agent-browser",
  paths: () => ({ runtimeDir: h.root, protectedPath: join(h.root, "protected-input.json") }),
  withSessionLock: async (_session: string, work: () => unknown) => work(),
}));
vi.mock("../src/protected-browser.js", () => ({
  validateProtectedRequest: () => {}, protectBrowserPage: h.prepare,
}));
vi.mock("../src/private-input-server.js", () => ({ startPrivateInputServer: async (options: unknown) => { h.serverOptions = options; return { port: 9999, requestId: "opaque", expiresAt: Date.now() + 600_000, done: h.done, close: h.serverClose }; } }));
vi.mock("../src/secure-input-demo-launch.js", async (original) => ({
  ...await original<object>(), readDemoTelegramProfile: async () => ({ botToken: "test-token", userId: 123 }), demoTelegramRequest: h.send,
}));
import { runPrivateBrowserInput } from "../src/private-browser-input.js";

describe("protected operation lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    h.root = await mkdtemp(join(tmpdir(), "private-browser-operation-"));
    vi.stubEnv("XDG_RUNTIME_DIR", h.root); vi.stubEnv("PI_TELEGRAM_BRIDGE_INSTANCE_ID", "test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    h.pageClose.mockResolvedValue(undefined); h.serverClose.mockResolvedValue(undefined);
    h.prepare.mockResolvedValue({ close: h.pageClose, submit: vi.fn() });
    h.send.mockResolvedValue(42); h.done = Promise.resolve("submitted");
    let checks = 0;
    h.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "agent-browser") return { stdout: "" };
      if (args[0] === "status") return { stdout: JSON.stringify({ Self: { DNSName: "test.tail123.ts.net." } }) };
      return { stdout: JSON.stringify(checks++ === 0 ? {} : { Foreground: { owned: {
        Web: { "test.tail123.ts.net:8446": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
      } } }) };
    });
    h.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { kill: vi.fn() }));
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(h.root, { recursive: true, force: true }); });
  const run = (chatId = 123, signal = new AbortController().signal) => runPrivateBrowserInput({
    config: { instanceId: "test", telegramSurface: { type: "private" }, agentDir: "/unused", telegramProfile: "test", resourceRoot: "/release" } as BridgeInstanceConfig,
    request: { session: "default", pageUrl: "https://example.com/login", resumeUrl: "https://example.com/home", fields: [{ kind: "password", selector: "#password" }], submitSelector: "button" },
    chatId, signal, notifyWaiting: vi.fn(),
  });
  it("disconnects the owned observer before preparation and cleans resources before returning", async () => {
    expect(await run()).toEqual({ status: "submitted" });
    expect(h.exec.mock.calls[0]).toEqual(["agent-browser", ["--session", "owned-agent-session", "--cdp", "1234", "close"], expect.any(Object)]);
    expect(h.serverClose).toHaveBeenCalledOnce(); expect(h.pageClose).toHaveBeenCalledOnce();
    await expect(readFile(join(h.root, "protected-input.json"))).rejects.toThrow();
    expect(h.send).toHaveBeenLastCalledWith("test-token", "editMessageText", expect.objectContaining({ message_id: 42, reply_markup: { inline_keyboard: [] } }));
  });
  it("retains the gate when sensitive-document cleanup fails", async () => {
    h.pageClose.mockRejectedValue(new Error("synthetic-secret-123"));
    expect(await run()).toEqual({ status: "browser_blocked" });
    expect(await readFile(join(h.root, "protected-input.json"), "utf8")).not.toContain("synthetic-secret-123");
  });
  it("rejects other chats before creating a listener or touching Chrome", async () => {
    expect(await run(456)).toEqual({ status: "unavailable" }); expect(h.spawn).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
  });
  it("handles preflight failure without publishing a form or retaining a clean gate", async () => {
    h.prepare.mockRejectedValue(new Error("synthetic-site-content"));
    expect(await run()).toEqual({ status: "unavailable" }); expect(h.send).not.toHaveBeenCalled();
    await expect(readFile(join(h.root, "protected-input.json"))).rejects.toThrow();
  });
  it("keeps the gate and observer disconnected while the form advances between private steps", async () => {
    let finish!: (status: string) => void;
    h.done = new Promise((resolve) => { finish = resolve; });
    const submit = vi.fn(async () => ["code"]);
    h.prepare.mockResolvedValue({ close: h.pageClose, submit });
    const pending = run();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
    expect(await h.serverOptions.submit(["synthetic@example.invalid"])).toEqual(["code"]);
    expect(await readFile(join(h.root, "protected-input.json"), "utf8")).not.toContain("synthetic@");
    expect(h.pageClose).not.toHaveBeenCalled();
    finish("cancelled"); expect(await pending).toEqual({ status: "cancelled" });
    expect(h.pageClose).toHaveBeenCalledOnce();
  });
});
