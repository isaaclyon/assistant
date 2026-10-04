import { afterEach, describe, expect, it, vi } from "vitest";
import { debugEnabled, debugStatus, debugText, publishDebug, sensitiveDebugCall, setDebug } from "../src/debug-messages.js";

const store = globalThis as Record<PropertyKey, unknown>;
const transportKey = Symbol.for("pi-telegram-bridge.debug-transport");
const stateKey = Symbol.for("pi-telegram-bridge.debug-state");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { delete store[transportKey]; delete store[stateKey]; });

describe("Telegram debug delivery", () => {
  it("defaults off, isolates topics, and captures the original destination", async () => {
    let target = { chatId: 7, threadId: 4 };
    const send = vi.fn(async () => {});
    store[transportKey] = { getActiveTarget: () => target, send };
    publishDebug("off", "hidden");
    expect(send).not.toHaveBeenCalled();
    setDebug(target, true);
    publishDebug("call", { query: "Emma" });
    target = { chatId: 7, threadId: 5 };
    publishDebug("other topic", "hidden");
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toEqual([{ chatId: 7, threadId: 4 }, '🔎 call\n{\n  "query": "Emma"\n}']);
    expect(debugEnabled(target)).toBe(false);
    expect(debugStatus(target)).toContain("off");
  });

  it("disabling invalidates pending sends even after re-enabling", async () => {
    const target = { chatId: 1 };
    const send = vi.fn(async () => {});
    store[transportKey] = { getActiveTarget: () => target, send };
    setDebug(target, true);
    publishDebug("queued", "hidden");
    setDebug(target, false);
    setDebug(target, true);
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("counts failures without rejecting agent work and bounds the queue", async () => {
    const target = { chatId: 1 };
    const send = vi.fn(async () => { throw new Error("network"); });
    store[transportKey] = { getActiveTarget: () => target, send };
    setDebug(target, true);
    for (let i = 0; i < 130; i++) publishDebug("call", i);
    expect(debugStatus(target)).toContain("2 messages dropped");
    await flush();
    expect(debugStatus(target)).toMatch(/[1-9]\d* failed sends/);
  });

  it("never sends without an active turn, even when enabled", async () => {
    const send = vi.fn();
    store[transportKey] = { getActiveTarget: () => undefined, send };
    setDebug({ chatId: 1 }, true);
    publishDebug("call", "hidden");
    await flush();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("debug redaction", () => {
  it("redacts structured credentials, binary data, and common textual tokens", () => {
    const output = debugText({ password: "pw-example", api_key: "key-example", code: "123456", nested: { accessToken: "access-example" }, data: "binary-example", text: "Bearer abc.def TOKEN=secret-example sk-abcdefghijklmnop <!-- telegram_button: click -->" });
    for (const secret of ["pw-example", "key-example", "123456", "access-example", "binary-example", "abc.def", "secret-example", "sk-abcdefghijklmnop", "telegram_button"]) expect(output).not.toContain(secret);
  });
  it("redacts before truncating and handles unsupported serialization", () => {
    expect(debugText("TOKEN=" + "x".repeat(5000))).toBe("TOKEN=[redacted]");
    expect(debugText("x".repeat(5000)).length).toBeLessThanOrEqual(3400);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(debugText(cycle)).toBe("[unavailable]");
  });
  it("omits private-flow and credential-bearing shell/read calls", () => {
    expect(sensitiveDebugCall("private_browser_login", {})).toBe(true);
    expect(sensitiveDebugCall("browser_takeover", {})).toBe(true);
    expect(sensitiveDebugCall("exec_command", { cmd: "cat ~/.pi/agent/telegram.json" })).toBe(true);
    expect(sensitiveDebugCall("exec_command", { cmd: "printenv" })).toBe(true);
    expect(sensitiveDebugCall("assistant_memory_search", { query: "Emma" })).toBe(false);
  });
});
