import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindUsage, formatUsage } from "../src/usage.js";

const now = Date.UTC(2026, 9, 4, 20);
const model = { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
const window = (usedPercent: number, windowMinutes = 300, remainingMinutes = 150) => ({ usedPercent, windowMinutes, resetsAt: (now + remainingMinutes * 60_000) / 1000 });
const snapshot = { limits: [{ limitId: "codex", primary: window(30), secondary: window(80, 10_080, 5040) }], raw: { secret: "never render" } };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("usage and pace", () => {
  it("compares remaining quota to remaining time for both windows", () => {
    const text = formatUsage(model, snapshot, now);
    expect(text).toContain("GPT-6 Sol");
    expect(text).toContain("5-hour: 70% remaining · 30% used");
    expect(text).toContain("20 percentage points under pace");
    expect(text).toContain("Weekly: 20% remaining · 80% used");
    expect(text).toContain("30 percentage points over pace");
    expect(text).toContain("Pace target: 50% remaining");
    expect(text).not.toContain("never render");
  });

  it("includes shared quota and matching model limits, excludes unrelated limits", () => {
    const text = formatUsage(model, { ...snapshot, limits: [...snapshot.limits,
      { limitId: "gpt-6-sol", primary: window(50) },
      { limitId: "gpt-6-astra", primary: window(90) },
    ] }, now);
    expect(text).toContain("Model allowance");
    expect(text).not.toContain("90% used");
    expect(text).toContain("on pace");
  });

  it("does not invent pace for expired, missing, or future-window metadata", () => {
    for (const primary of [window(20, 300, 0), window(20, 300, 400), { usedPercent: 20 }, { windowMinutes: 300 }]) {
      const text = formatUsage(model, { limits: [{ limitId: "codex", primary }], raw: {} }, now);
      expect(text).not.toContain("Pace target");
      expect(text).toContain("pace unavailable");
    }
    expect(formatUsage(model, { limits: [], raw: {} }, now)).toContain("No allowance data");
  });

  it("resolves the active session per call and redacts upstream failures", async () => {
    let current = { model } as unknown as ExtensionContext;
    const fetchUsage = vi.fn(async () => snapshot);
    const session = () => ({ extensionRunner: { createCommandContext: () => current } } as unknown as Pick<AgentSession, "extensionRunner">);
    const unbind = bindUsage(session, { fetchUsage, now: () => now });
    const read = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.usage")] as () => Promise<string>;
    try {
      expect(await read()).toContain("GPT-6 Sol");
      current = { model: { ...model, id: "gpt-6-astra", name: "GPT-6 Astra" } } as unknown as ExtensionContext;
      expect(await read()).toContain("GPT-6 Astra");
      fetchUsage.mockRejectedValueOnce(new Error("private response credential"));
      expect(await read()).toBe("Usage is unavailable right now. Try /usage again shortly.");
      current = { model: { ...model, provider: "other", api: "openai-responses" } } as unknown as ExtensionContext;
      expect(await read()).toContain("unavailable for GPT-6 Sol");
      expect(fetchUsage).toHaveBeenCalledTimes(3);
    } finally { unbind(); }
    expect((globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.usage")]).toBeUndefined();
  });

  it("bounds a stalled usage request", async () => {
    vi.useFakeTimers();
    const unbind = bindUsage(() => ({ extensionRunner: { createCommandContext: () => ({ model }) } } as unknown as Pick<AgentSession, "extensionRunner">), {
      fetchUsage: () => new Promise(() => {}),
    });
    try {
      const read = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.usage")] as () => Promise<string>;
      const result = read();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toContain("unavailable right now");
    } finally { unbind(); }
  });

  it("asks for a fresh read if the model changes during the request", async () => {
    let active = model;
    const unbind = bindUsage(() => ({ extensionRunner: { createCommandContext: () => ({ model: active }) } } as unknown as Pick<AgentSession, "extensionRunner">), {
      fetchUsage: async () => { active = { ...model, id: "gpt-6-astra" }; return snapshot; },
    });
    try {
      const read = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.usage")] as () => Promise<string>;
      expect(await read()).toBe("The active model changed while checking usage. Run /usage again.");
    } finally { unbind(); }
  });

  it("uses Pi provider auth and the pinned read-only usage client", async () => {
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.test`;
    const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: token, baseUrl: model.baseUrl } }));
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).get("chatgpt-account-id")).toBe("synthetic-account");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith("/wham/usage")) return new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: window(30).resetsAt } },
        rate_limit_reset_credits: { available_count: 0 }, private: "private upstream text",
      }));
      throw new Error("Unexpected endpoint");
    });
    vi.stubGlobal("fetch", fetch);
    const unbind = bindUsage(() => ({ extensionRunner: { createCommandContext: () => ({ model, modelRegistry: { getProviderAuth } }) } } as unknown as Pick<AgentSession, "extensionRunner">), { now: () => now });
    try {
      const read = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.usage")] as () => Promise<string>;
      const text = await read();
      expect(text).toContain("70% remaining");
      expect(text).not.toContain("private upstream text");
      expect(text).not.toContain(token);
      expect(getProviderAuth).toHaveBeenCalledWith("openai-codex");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { unbind(); }
  });

  it("registers a reload-safe menu command and replies without an agent turn", async () => {
    const { default: extend } = await import(new URL("../.pi/extensions/usage.ts", import.meta.url).href);
    const registry = await import(new URL("../node_modules/@llblab/pi-telegram/lib/commands.ts", import.meta.url).href);
    const unbind = bindUsage(() => ({ extensionRunner: { createCommandContext: () => ({ model }) } } as unknown as Pick<AgentSession, "extensionRunner">), { fetchUsage: async () => snapshot, now: () => now });
    try {
      extend({}); extend({});
      const commands = registry.getTelegramExtensionCommands().filter((c: { name: string }) => c.name === "usage");
      expect(commands).toHaveLength(1);
      expect(commands[0].showInMenu).toBe(true);
      const ctx = { args: "", reply: vi.fn(), enqueuePrompt: vi.fn() };
      await commands[0].handler(ctx);
      expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining("70% remaining"));
      expect(ctx.enqueuePrompt).not.toHaveBeenCalled();
      unbind();
      await commands[0].handler(ctx);
      expect(ctx.reply).toHaveBeenLastCalledWith("Usage is unavailable outside the assistant runtime.");
    } finally {
      unbind(); registry.clearTelegramExtensionCommands();
      delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.command-unbind.usage")];
    }
  });
});
