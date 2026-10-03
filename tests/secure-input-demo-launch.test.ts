import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertDemoPortUnused, demoTelegramRequest, isPrivateDemoProxy, readDemoTelegramProfile } from "../src/secure-input-demo-launch.js";

describe("private demo launch boundaries", () => {
  const host = "test.tail123.ts.net:8445";
  const mapping = { Web: { [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:34567" } } } } };
  it("allows an unused port without disturbing other endpoints", () => {
    expect(() => assertDemoPortUnused({ TCP: { "443": {} }, AllowFunnel: { "test:443": true } }, 8445)).not.toThrow();
    expect(() => assertDemoPortUnused({}, 0)).toThrow();
  });
  it.each([
    { TCP: { "8445": {} } }, mapping,
    { AllowFunnel: { [host]: true } },
    { Foreground: { owned: mapping } },
    { Foreground: { owned: { AllowFunnel: { [host]: true } } } },
  ])("refuses a port with existing state", (state) => {
    expect(() => assertDemoPortUnused(state, 8445)).toThrow();
  });
  it("verifies the exact proxy with no shadowing handler or Funnel", () => {
    expect(isPrivateDemoProxy({ Foreground: { owned: mapping } }, host, "http://127.0.0.1:34567")).toBe(true);
    expect(isPrivateDemoProxy({ ...mapping, Foreground: { owned: mapping } }, host, "http://127.0.0.1:34567")).toBe(false);
    expect(isPrivateDemoProxy({ ...mapping, AllowFunnel: { [host]: true } }, host, "http://127.0.0.1:34567")).toBe(false);
    expect(isPrivateDemoProxy(mapping, host, "http://127.0.0.1:9999")).toBe(false);
  });
  it("loads only the selected paired named profile from private configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "demo-profile-test-"));
    try {
      await writeFile(join(root, "telegram.json"), JSON.stringify({ profiles: {
        selected: { botToken: "test-token", allowedUserId: 123 },
        other: { botToken: "other-token", allowedUserId: 456 },
      } }), { mode: 0o600 });
      expect(await readDemoTelegramProfile(root, "selected")).toEqual({ botToken: "test-token", userId: 123 });
      await expect(readDemoTelegramProfile(root, "missing")).rejects.toThrow("paired named");
    } finally { await rm(root, { recursive: true }); }
  });
  it("never surfaces Telegram token URLs or response diagnostics", async () => {
    const request = vi.fn(async () => { throw new Error("https://api.telegram.org/botSECRET/sendMessage"); });
    await expect(demoTelegramRequest("SECRET", "sendMessage", {}, request)).rejects.toThrow(/^Telegram demo delivery failed$/);
    const failure = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "SECRET" })));
    await expect(demoTelegramRequest("SECRET", "sendMessage", {}, failure)).rejects.toThrow(/^Telegram demo delivery failed$/);
  });
});
