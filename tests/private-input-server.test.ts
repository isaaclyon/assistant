import { createHmac } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPrivateInputServer } from "../src/private-input-server.js";
import { validateProtectedRequest, type ProtectedInputRequest } from "../src/protected-browser.js";
import { openTableRequest } from "../src/opentable-private-flow.js";

const request: ProtectedInputRequest = { session: "default", pageUrl: "https://login.example/form", resumeUrl: "https://login.example/home",
  fields: [{ kind: "password", selector: "#password" }], submitSelector: "#submit" };
const botToken = "123:test-only", origin = "https://private.example.ts.net:8446";
function signed(userId = 123) {
  const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) }); fields.sort();
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  fields.set("hash", createHmac("sha256", key).update([...fields].map(([k, v]) => `${k}=${v}`).join("\n")).digest("hex"));
  return fields.toString();
}
describe("protected request validation", () => {
  it.each([
    { ...request, pageUrl: "http://login.example/form" },
    { ...request, resumeUrl: "https://other.example/" },
    { ...request, resumeUrl: "https://login.example/?token=secret" },
    { ...request, fields: [{ kind: "username", selector: "#user" }] },
  ])("refuses unsupported requests", (input) => expect(() => validateProtectedRequest(input as ProtectedInputRequest)).toThrow());
  it("pins the site flow to its exact origin, page, resume URL and owned fields", () => {
    const flow = openTableRequest("opentable");
    expect(() => validateProtectedRequest(flow)).not.toThrow();
    for (const patch of [{ pageUrl: "https://other.example/" }, { pageUrl: "https://www.opentable.com/booking" },
      { resumeUrl: "https://www.opentable.com/?secret=x" }, { submitSelector: "button" }, { fields: [{ kind: "password", selector: "#payment" }] }]) {
      expect(() => validateProtectedRequest({ ...flow, ...patch } as ProtectedInputRequest)).toThrow();
    }
  });
});
describe("private input HTTP boundary", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
  async function fixture(submit: (values: string[]) => Promise<void | Array<"password" | "code">> = vi.fn(async () => {}), durationMs = 60_000, flow = false) {
    const controller = new AbortController();
    const server = await startPrivateInputServer({ origin, botToken, userId: 123, request: flow ? { ...request, flow: "opentable", fields: [{ kind: "username", selector: "#email" }] } : request,
      assetsDir: join(process.cwd(), "web/private-input"), signal: controller.signal, submit, durationMs });
    cleanup.push(server.close);
    let step: string;
    const post = (path: string, extra: object = {}, from = origin) => fetch(`http://127.0.0.1:${server.port}/api/${path}`, {
      method: "POST", headers: { "content-type": "application/json", origin: from }, body: JSON.stringify({ requestId: server.requestId, initData: signed(), ...(path === "submit" ? { step } : {}), ...extra }),
    });
    step = (await (await post("auth")).json()).step;
    return { server, controller, submit, post };
  }
  it("passes values only to the browser and returns a fixed terminal status", async () => {
    const f = await fixture();
    const auth = await (await f.post("auth")).json();
    expect(auth).toEqual({ status: "pending", origin: "https://login.example", fields: ["password"], step: expect.any(String) });
    const result = await f.post("submit", { values: ["synthetic-secret-123"] });
    expect(await result.text()).toBe('{"status":"submitted"}');
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(["synthetic-secret-123"]);
    expect(await f.server.done).toBe("submitted");
    expect((await f.post("submit", { values: ["synthetic-secret-123"] })).status).toBe(409);
  });
  it("rejects forwarded requests, foreign origins, arbitrary fields and oversized input", async () => {
    const f = await fixture();
    expect((await f.post("submit", { values: ["secret"], initData: signed(999) })).status).toBe(403);
    expect((await f.post("submit", { values: ["secret"] }, "https://evil.invalid")).status).toBe(403);
    expect((await f.post("submit", { values: ["secret"], password: "extra" })).status).toBe(400);
    expect((await f.post("submit", { values: ["x".repeat(1025)] })).status).toBe(400);
    expect((await f.post("submit", { values: ["x".repeat(25000)] })).status).toBe(413);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("consumes before awaiting and hides browser exceptions containing secrets", async () => {
    let fail!: () => void;
    const submit = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("synthetic-secret-123")); }));
    const f = await fixture(submit);
    const first = f.post("submit", { values: ["synthetic-secret-123"] });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect((await f.post("submit", { values: ["synthetic-secret-123"] })).status).toBe(409);
    fail();
    expect(await (await first).text()).not.toContain("synthetic-secret-123");
    expect(await f.server.done).toBe("failed");
  });
  it("cancels, aborts and expires without filling", async () => {
    const a = await fixture(); await a.post("cancel"); expect(await a.server.done).toBe("cancelled");
    const b = await fixture(); b.controller.abort(); expect(await b.server.done).toBe("cancelled");
    const c = await fixture(undefined, 20); expect(await c.server.done).toBe("expired");
    for (const f of [a, b, c]) expect(f.submit).not.toHaveBeenCalled();
  });
  it("keeps a multi-step flow private and rejects stale step replays", async () => {
    const submit = vi.fn<(values: string[]) => Promise<void | Array<"code">>>()
      .mockResolvedValueOnce(["code"]).mockResolvedValueOnce(undefined);
    const f = await fixture(submit, 60_000, true);
    const next = await (await f.post("submit", { values: ["synthetic@example.invalid"] })).json();
    expect(next).toMatchObject({ status: "pending", fields: ["code"], step: expect.any(String) });
    expect(JSON.stringify(next)).not.toContain("synthetic@");
    expect((await f.post("submit", { values: ["123456"] })).status).toBe(409);
    expect((await f.post("submit", { step: next.step, values: ["123"] })).status).toBe(400);
    const last = await f.post("submit", { step: next.step, values: ["123456"] });
    expect(await last.json()).toEqual({ status: "submitted" });
    expect(await f.server.done).toBe("submitted");
    expect(submit).toHaveBeenCalledTimes(2);
  });
  it.each(["abort", "expiry"])("does not reopen a pending step after %s during browser work", async (end) => {
    let advance!: (value: Array<"code">) => void;
    const submit = vi.fn(() => new Promise<Array<"code">>((resolve) => { advance = resolve; }));
    const f = await fixture(submit, end === "expiry" ? 100 : 60_000, true);
    const first = f.post("submit", { values: ["synthetic@example.invalid"] });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    if (end === "abort") f.controller.abort(); else await new Promise((resolve) => setTimeout(resolve, 110));
    advance(["code"]);
    await first;
    expect(await f.server.done).toBe(end === "abort" ? "cancelled" : "expired");
  });
  it("cancels between steps without another browser submission", async () => {
    const submit = vi.fn(async (): Promise<Array<"code">> => ["code"]);
    const f = await fixture(submit, 60_000, true);
    await f.post("submit", { values: ["synthetic@example.invalid"] });
    await f.post("cancel");
    expect(await f.server.done).toBe("cancelled"); expect(submit).toHaveBeenCalledOnce();
  });
});
