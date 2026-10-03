import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSecureInputDemo, validateMiniAppIdentity } from "../src/secure-input-demo.js";

const botToken = "123456:unit-test-token";
const userId = 123;
const now = 1_800_000_000_000;
const origin = "https://demo.example.ts.net:8445";
function signedData(fields: Record<string, string> = {}, token = botToken) {
  const data = new URLSearchParams({ auth_date: String(now / 1000), user: JSON.stringify({ id: userId }), ...fields });
  data.sort();
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", key).update([...data].map(([k, v]) => `${k}=${v}`).join("\n")).digest("hex");
  data.set("hash", hash);
  return data.toString();
}

describe("Mini App identity", () => {
  it("authenticates signed launch data for the paired user", () => {
    expect(validateMiniAppIdentity(signedData(), botToken, userId, now)).toBe(true);
  });
  it.each([
    () => signedData({ user: JSON.stringify({ id: 999 }) }),
    () => signedData({ auth_date: String(now / 1000 - 601) }),
    () => signedData({ auth_date: String(now / 1000 + 31) }),
    () => signedData({}, "another-bot"),
    () => `${signedData()}&user=%7B%22id%22%3A123%7D`,
    () => signedData().replace("auth_date=1800000000", "auth_date=1800000001"),
    () => signedData({ user: "null" }),
    () => "hash=oops",
  ])("rejects untrusted or stale launch data", (input) => {
    expect(validateMiniAppIdentity(input(), botToken, userId, now)).toBe(false);
  });
});

describe("dummy input service", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
  async function fixture() {
    let clock = now;
    const onTerminal = vi.fn();
    const service = await startSecureInputDemo({ botToken, userId, origin, now: () => clock, onTerminal });
    cleanup.push(service.close);
    const base = `http://127.0.0.1:${service.port}`;
    const post = (path: string, body: object = {}, requestOrigin = origin) => fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json", origin: requestOrigin },
      body: JSON.stringify({ requestId: service.requestId, initData: signedData(), ...body }),
    });
    return { service, base, post, onTerminal, advance: () => { clock += 16 * 60_000; } };
  }
  it("serves only explicit assets without caching", async () => {
    const { base } = await fixture();
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await page.text()).toContain("123456");
    expect((await fetch(`${base}/../telegram.json`)).status).toBe(404);
  });
  it("authenticates and consumes a request once without returning values", async () => {
    const { post, onTerminal } = await fixture();
    expect(await (await post("/api/auth")).json()).toEqual({ status: "pending" });
    const responses = await Promise.all([post("/api/submit", { code: "123456" }), post("/api/submit", { code: "123456" })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(onTerminal).toHaveBeenCalledExactlyOnceWith("completed");
    expect(await (await post("/api/auth")).json()).toEqual({ status: "completed" });
  });
  it("rejects arbitrary input, origins, identities, and request IDs", async () => {
    const { post, onTerminal } = await fixture();
    expect((await post("/api/submit", { code: "secret" })).status).toBe(400);
    expect((await post("/api/auth", {}, "https://evil.invalid")).status).toBe(403);
    expect((await post("/api/auth", { initData: "fake" })).status).toBe(403);
    expect((await post("/api/auth", { requestId: "wrong" })).status).toBe(403);
    expect((await post("/api/submit", { code: "123456", password: "secret" })).status).toBe(400);
    expect(onTerminal).not.toHaveBeenCalled();
  });
  it("bounds payload size and rejects unsupported request shapes", async () => {
    const { post, base } = await fixture();
    expect((await post("/api/auth", { initData: "x".repeat(20_000) })).status).toBe(413);
    expect((await fetch(`${base}/api/auth`, { method: "POST", headers: { origin }, body: "null" })).status).toBe(415);
  });
  it("cancels once and expires pending requests", async () => {
    const first = await fixture();
    expect(await (await first.post("/api/cancel")).json()).toEqual({ status: "cancelled" });
    expect((await first.post("/api/submit", { code: "123456" })).status).toBe(409);
    expect(first.onTerminal).toHaveBeenCalledExactlyOnceWith("cancelled");
    const second = await fixture();
    second.advance();
    expect((await second.post("/api/submit", { code: "123456" })).status).toBe(410);
    expect(second.onTerminal).not.toHaveBeenCalled();
  });
});
