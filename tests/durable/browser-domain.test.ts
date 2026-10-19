import { describe, expect, it, vi } from "vitest";
import { isTrustedPrivateExecution, type PrivateBrowserConfig } from "../../src/private-browser-config.js";

const mocks = vi.hoisted(() => ({ blocked: true }));
vi.mock("../../.pi/skills/agent-browser/scripts/stock-chrome.mjs", () => ({
  agentSessionName: (s: string) => s, current: async () => undefined, executable: async () => "x",
  paths: () => ({ runtimeDir: "/nonexistent", protectedPath: "/nonexistent/protected.json" }),
  withSessionLock: async (_s: string, run: () => unknown) => run(),
  assertUnprotected: async () => { if (mocks.blocked) throw new Error("gate present"); },
}));
vi.mock("../../src/secure-input-demo-launch.js", async (original) => ({
  ...(await original<object>()), readDemoTelegramProfile: async () => ({ userId: 7, botToken: "t" }),
}));

const config = (over: Partial<PrivateBrowserConfig> = {}): PrivateBrowserConfig => ({
  instanceId: "native", telegramSurface: { type: "private" }, telegramProfile: "p", agentDir: "/a",
  resourceRoot: "/r", credentialScope: "s", executionInstanceId: "native", ...over,
});

describe("private browser config seam", () => {
  it("trusts only a private surface running as the configured instance", () => {
    expect(isTrustedPrivateExecution(config())).toBe(true);
    expect(isTrustedPrivateExecution(config({ executionInstanceId: "other" }))).toBe(false);
    expect(isTrustedPrivateExecution(config({ telegramSurface: { type: "group" } }))).toBe(false);
  });

  it("reports browser_blocked when a protected-input gate exists, without touching it", async () => {
    const { runPrivateBrowserInput } = await import("../../src/private-browser-input.js");
    const { runBrowserTakeover } = await import("../../src/browser-takeover.js");
    const signal = new AbortController().signal;
    const input = await runPrivateBrowserInput({ config: config(), chatId: 7, signal, notifyWaiting() {},
      request: { session: "s1", pageUrl: "https://example.com/login", resumeUrl: "https://example.com/",
        fields: [{ kind: "password", selector: "#p" }], submitSelector: "#go" } as never }).catch((e) => e);
    expect(input).not.toBeInstanceOf(Error); expect(input.status).toBe("browser_blocked");
    const takeover = await runBrowserTakeover({ config: config(), chatId: 7, signal, notifyWaiting() {},
      request: { session: "s1", resumeUrl: "https://example.com/" } as never }).catch((e) => e);
    expect(takeover).not.toBeInstanceOf(Error); expect(takeover.status).toBe("browser_blocked");
  });

  it("refuses an untrusted identity before reading anything", async () => {
    const { runBrowserTakeover } = await import("../../src/browser-takeover.js");
    const r = await runBrowserTakeover({ config: config({ executionInstanceId: "x" }), chatId: 7, signal: new AbortController().signal,
      notifyWaiting() {}, request: { session: "s1", resumeUrl: "https://example.com/" } as never }).catch((e) => e);
    expect(r).not.toBeInstanceOf(Error); expect(r.status).toBe("unavailable");
  });
});
