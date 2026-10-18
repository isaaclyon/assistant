import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeInstanceConfig } from "../src/config.js";
import type { TakeoverResult } from "../src/browser-takeover-server.js";
const h = vi.hoisted(() => ({ root: "", removed: false, checks: 0, activeHandoff: false,
  exec: vi.fn(), spawn: vi.fn(), finish: vi.fn(), closeCdp: vi.fn(), serverClose: vi.fn(), send: vi.fn(), assert: vi.fn(),
  prepare: vi.fn(), stop: vi.fn(), privatePage: vi.fn(), approve: vi.fn(), done: Promise.resolve({ status: "handed_back", mode: "share" } as TakeoverResult) }));
vi.mock("node:util", () => ({ promisify: () => h.exec }));
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: h.spawn }));
vi.mock("../.pi/skills/agent-browser/scripts/stock-chrome.mjs", () => ({
  agentSessionName: () => "owned-observer", assertUnprotected: h.assert,
  current: async () => ({ launchId: "owned-browser", port: 1234 }), executable: async () => "agent-browser",
  paths: () => ({ runtimeDir: h.root, protectedPath: join(h.root, "protected-input.json") }),
  withSessionLock: async (_session: string, work: () => unknown) => work(),
}));
vi.mock("../.pi/skills/agent-browser/scripts/browser-handoff.mjs", () => ({
  hasActiveHandoff: async () => h.activeHandoff,
  startPrivateHandoff: async () => ({ webPort: 8888, passwordPath: join(h.root, "handoff-password"), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  stopPrivateHandoff: h.stop,
}));
vi.mock("../src/browser-takeover-protection.js", () => ({ validateTakeoverRequest: () => {}, protectBrowserTakeover: h.prepare }));
vi.mock("../src/private-login.js", async original => ({ ...await original<object>(), protectPrivateLogin: h.privatePage }));
vi.mock("../src/private-approved-credential.js", () => ({ privateApprovedCredential: h.approve }));
vi.mock("../src/browser-takeover-server.js", () => ({ startTakeoverServer: async () => ({ port: 9999, requestId: "opaque", done: h.done, close: h.serverClose }) }));
vi.mock("../src/secure-input-demo-launch.js", async (original) => ({ ...await original<object>(),
  readDemoTelegramProfile: async () => ({ botToken: "synthetic", userId: 123 }), demoTelegramRequest: h.send }));
import { runBrowserTakeover } from "../src/browser-takeover.js";
describe("takeover ownership and teardown", () => {
  beforeEach(async () => {
    vi.resetAllMocks(); h.checks = 0; h.removed = false; h.activeHandoff = false;
    h.root = await mkdtemp(join(tmpdir(), "takeover-lifecycle-"));
    await writeFile(join(h.root, "handoff-password"), "testOnly\n", { mode: 0o600 });
    vi.stubEnv("XDG_RUNTIME_DIR", h.root); vi.stubEnv("PI_TELEGRAM_BRIDGE_INSTANCE_ID", "test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    h.prepare.mockResolvedValue({ finish: h.finish, close: h.closeCdp }); h.send.mockResolvedValue(42);
    h.done = Promise.resolve({ status: "handed_back", mode: "share" });
    h.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "agent-browser") return { stdout: "" };
      if (args[0] === "status") return { stdout: JSON.stringify({ Self: { DNSName: "test.tail123.ts.net." } }) };
      const serving = { Foreground: { owned: { Web: {
        "test.tail123.ts.net:8447": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
      } } } };
      return { stdout: JSON.stringify(h.checks++ === 0 || h.removed ? {} : serving) };
    });
    h.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { kill: () => { h.removed = true; } }));
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(h.root, { recursive: true, force: true }); });
  const run = (chatId = 123, onDiagnostic?: (event: unknown) => void) => runBrowserTakeover({ config: { instanceId: "test", telegramSurface: { type: "private" }, resourceRoot: process.cwd() } as BridgeInstanceConfig,
    request: { session: "default", resumeUrl: "https://example.com/" }, chatId, signal: new AbortController().signal, notifyWaiting() {}, onDiagnostic });
  it("reports observer disconnection failure without exposing process output or clearing the gate", async () => {
    const diagnostic = vi.fn(), previous = h.exec.getMockImplementation()!;
    const failure = Object.assign(new Error("synthetic-secret-message"), { code: 1, stdout: "synthetic-secret-output", stderr: "synthetic-secret-error" });
    h.exec.mockImplementation((binary, ...args) => binary === "agent-browser" ? Promise.reject(failure) : previous(binary, ...args));
    expect(await run(123, diagnostic)).toEqual({ status: "browser_blocked" });
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ operation: "takeover", phase: "observer-disconnect", exitCode: 1 }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("synthetic-secret");
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    expect(await readFile(join(h.root, "protected-input.json"), "utf8")).toContain("owned-browser");
  });
  it("retains the gate if protected preparation fails after observer disconnection", async () => {
    const diagnostic = vi.fn();
    h.prepare.mockRejectedValueOnce(new Error("synthetic-private-failure"));
    expect(await run(123, diagnostic)).toEqual({status:"browser_blocked"});
    expect(await readFile(join(h.root,"protected-input.json"),"utf8")).not.toContain("synthetic-private-failure");
    expect(h.finish).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith({ operation: "takeover", phase: "page-protect" });
  });
  it("pauses the observer and revokes viewer access before restoring the shared page and clearing the gate", async () => {
    let complete!: (value: TakeoverResult) => void; h.done = new Promise(resolve => { complete = resolve; });
    const result = run();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
    expect(await readFile(join(h.root, "protected-input.json"), "utf8")).not.toContain("testOnly");
    expect(h.finish).not.toHaveBeenCalled();
    complete({ status: "handed_back", mode: "share" });
    expect(await result).toEqual({ status: "handed_back", mode: "share" });
    expect(h.finish).toHaveBeenCalledExactlyOnceWith("share");
    expect(h.serverClose.mock.invocationCallOrder[0]).toBeLessThan(h.stop.mock.invocationCallOrder[0]!);
    expect(h.stop.mock.invocationCallOrder[0]).toBeLessThan(h.finish.mock.invocationCallOrder[0]!);
    await expect(readFile(join(h.root, "protected-input.json"))).rejects.toThrow();
    expect(JSON.stringify(h.send.mock.calls)).not.toContain("testOnly");
  });
  it.each(["expired", "cancelled", "failed"] as const)("uses private cleanup on %s", async status => {
    h.done = Promise.resolve({ status, mode: "private" }); expect(await run()).toEqual({ status, mode: "private" });
    expect(h.finish).toHaveBeenCalledExactlyOnceWith("private");
  });
  it.each(["viewer", "page"])("retains the crash gate after uncertain %s cleanup", async failure => {
    const diagnostic = vi.fn();
    (failure === "viewer" ? h.stop : h.finish).mockRejectedValue(new Error("synthetic-sensitive-error"));
    expect(await run(123, diagnostic)).toEqual({ status: "browser_blocked" });
    expect(diagnostic).toHaveBeenCalledWith({ operation: "takeover", phase: failure === "viewer" ? "cleanup-handoff" : "cleanup-page" });
    expect(await readFile(join(h.root, "protected-input.json"), "utf8")).not.toContain("sensitive");
    expect(h.closeCdp).toHaveBeenCalled();
    if (failure === "viewer") expect(h.finish).toHaveBeenCalledWith("private");
  });
  it("refuses wrong users or existing handoffs without launching anything", async () => {
    expect(await run(456)).toEqual({ status: "unavailable" });
    h.activeHandoff = true; expect(await run()).toEqual({ status: "unavailable" });
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
  });
  it("reports an existing crash gate as browser_blocked so stop-only recovery remains explicit", async () => {
    const diagnostic = vi.fn();
    h.assert.mockRejectedValue(new Error("blocked"));
    expect(await run(123, diagnostic)).toEqual({ status: "browser_blocked" }); expect(h.spawn).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ operation: "takeover", phase: "gate-existing" });
  });
  const runApproved = (onDiagnostic?: (event: unknown) => void) => runBrowserTakeover({ config: { instanceId: "test", telegramSurface: { type: "private" }, resourceRoot: process.cwd() } as BridgeInstanceConfig,
    request: { session: "default", resumeUrl: "https://example.com/" }, chatId: 123, signal: new AbortController().signal, notifyWaiting() {}, onDiagnostic,
    login: { session: "default", pageUrl: "https://example.com/login", resumeUrl: "https://example.com/", credentialItem: `source:${"a".repeat(26)}`, purpose: "Read account" } });
  it("identifies private login preparation failure before credential approval", async () => {
    const diagnostic = vi.fn();
    h.privatePage.mockRejectedValueOnce(new Error("synthetic-secret"));
    expect(await runApproved(diagnostic)).toEqual({ status: "unavailable" });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ operation: "login", phase: "login-protect" });
    expect(h.approve).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledWith("private");
  });
  it.each(["throw", "reject"])("preserves fail-closed cleanup when diagnostics %s", async failure => {
    h.prepare.mockRejectedValueOnce(new Error("synthetic-secret"));
    const sink = () => { if (failure === "throw") throw new Error("sink unavailable"); return Promise.reject(new Error("sink unavailable")); };
    expect(await run(123, sink)).toEqual({ status: "browser_blocked" });
    expect(await readFile(join(h.root, "protected-input.json"), "utf8")).toContain("owned-browser");
    expect(h.send).not.toHaveBeenCalled();
  });
  it("uses a provisioned endpoint without invoking Tailscale or sudo and closes it before releasing the page", async () => {
    vi.stubEnv("PI_TELEGRAM_TRUSTED_SOCKET", "/run/synthetic/socket");
    vi.stubEnv("PI_PRIVATE_BROWSER_BIND_ADDRESS", "10.253.250.2");
    vi.stubEnv("PI_PRIVATE_INPUT_ORIGIN", "https://test.tail123.ts.net:8446");
    vi.stubEnv("PI_PRIVATE_TAKEOVER_ORIGIN", "https://test.tail123.ts.net:8447");
    expect(await run()).toEqual({ status: "handed_back", mode: "share" });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.exec.mock.calls.every(call => call[0] === "agent-browser")).toBe(true);
    expect(h.serverClose.mock.invocationCallOrder[0]).toBeLessThan(h.finish.mock.invocationCallOrder[0]!);
  });
  it("retains one approved credential across username and password screens, then clears it", async () => {
    let step = 0;
    const submitted: string[][] = [], credential = { username: "synthetic-user", password: "synthetic-secret" };
    const close = vi.fn();
    h.privatePage.mockResolvedValue({ state: () => step < 2 ? { state: "fields", fields: [step ? "password" : "username"] } : { state: "complete" },
      submit: async (values: string[]) => { submitted.push([...values]); values.fill(""); step++; }, hasUsername: () => step > 0,
      matchesUsername: (value: string) => value === "synthetic-user", close });
    h.approve.mockImplementation(async () => {
      expect(await readFile(join(h.root, "protected-input.json"), "utf8")).toContain("owned-browser");
      return { status: "approved", credential, copiedItem: "b".repeat(26) };
    });
    expect(await runApproved()).toEqual({ status: "submitted", mode: "private", copiedCredentialItem: "b".repeat(26) });
    expect(submitted).toEqual([["synthetic-user"], ["synthetic-secret"]]);
    expect(credential).toEqual({ username: "", password: "" });
    expect(h.approve).toHaveBeenCalledOnce(); expect(h.spawn).not.toHaveBeenCalled(); expect(close).toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith("private");
  });
  it("does not submit after denial and privately releases the protected page", async () => {
    const submit = vi.fn();
    h.privatePage.mockResolvedValue({ state: () => ({ state: "fields", fields: ["username", "password"] }), submit, close: vi.fn() });
    h.approve.mockResolvedValue({ status: "denied" });
    expect(await runApproved()).toEqual({ status: "cancelled", mode: "private" });
    expect(submit).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith("private");
  });
  it("reports a successful copy independently when browser submission fails", async () => {
    const credential = { username: "synthetic-user", password: "synthetic-secret" };
    h.privatePage.mockResolvedValue({ state: () => ({ state: "fields", fields: ["username", "password"] }),
      submit: vi.fn().mockRejectedValue(new Error("synthetic failure")), close: vi.fn() });
    h.approve.mockResolvedValue({ status: "approved", credential, copiedItem: "b".repeat(26) });
    expect(await runApproved()).toEqual({ status: "unavailable", copiedCredentialItem: "b".repeat(26) });
    expect(credential).toEqual({ username: "", password: "" });
  });
});
