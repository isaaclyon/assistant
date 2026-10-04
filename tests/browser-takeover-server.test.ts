import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTakeoverServer } from "../src/browser-takeover-server.js";

const botToken = "123:synthetic", origin = "https://takeover.example.ts.net:8447";
function signed(userId = 123) {
  const params = new URLSearchParams({ auth_date: `${Math.floor(Date.now() / 1000)}`, user: JSON.stringify({ id: userId }) }); params.sort();
  params.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(botToken).digest()).update([...params].map(([k,v]) => `${k}=${v}`).join("\n")).digest("hex"));
  return params.toString();
}
const message = (ws: WebSocket) => new Promise<Buffer>((resolve) => ws.once("message", data => resolve(data as Buffer)));
describe("Telegram browser takeover boundary", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function fixture(durationMs = 60_000) {
    const http = createServer(), upstream = new WebSocketServer({ server: http });
    let connections = 0;
    upstream.on("connection", ws => { connections++; ws.send("RFB 003.008\n", { binary: true }); ws.on("message", data => ws.send(data, { binary: true })); });
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { for (const ws of upstream.clients) ws.terminate(); upstream.close(); await new Promise<void>(r => http.close(() => r())); });
    const controller = new AbortController();
    const resize = vi.fn(async (_viewport: { width: number; height: number; desktop: boolean }) => {});
    const server = await startTakeoverServer({ origin, botToken, userId: 123, signal: controller.signal, durationMs,
      resourceRoot: process.cwd(), upstreamPort: (http.address() as any).port, password: "testOnly", resumeUrl: "https://example.com/", resize });
    cleanup.push(server.close);
    const post = (path: string, extra: object = {}, from = origin) => fetch(`http://127.0.0.1:${server.port}/api/${path}`, {
      method: "POST", headers: { origin: from, "content-type": "application/json" }, body: JSON.stringify({ initData: signed(), requestId: server.requestId, ...extra }),
    });
    const socket = async (from = origin) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/socket`, { origin: from });
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      return ws;
    };
    return { server, post, socket, controller, resize, connections: () => connections };
  }
  it("binds bounded viewport changes to the paired user and current viewer", async () => {
    const f = await fixture(), viewport = { width: 390, height: 650, desktop: false };
    expect((await f.post("auth", { viewport, initData: signed(456) })).status).toBe(403);
    expect(f.resize).not.toHaveBeenCalled();
    for (const bad of [{ ...viewport, width: 99999 }, { ...viewport, height: 1.5 }, { ...viewport, command: "anything" }]) {
      expect((await f.post("auth", { viewport: bad })).status).toBe(400);
    }
    const auth = await (await f.post("auth", { viewport })).json();
    expect(f.resize).toHaveBeenCalledExactlyOnceWith(viewport);
    expect((await f.post("viewport", { ticket: auth.ticket, viewport })).status).toBe(409);
    const ws = await f.socket(), ready = message(ws); ws.send(JSON.stringify({ ticket: auth.ticket })); await ready;
    expect((await f.post("viewport", { ticket: "wrong", viewport })).status).toBe(403);
    expect((await f.post("viewport", { ticket: auth.ticket, viewport: { ...viewport, height: 350 } })).status).toBe(200);
    expect(f.resize).toHaveBeenLastCalledWith({ ...viewport, height: 350 });
  });
  it("revokes viewing immediately but waits for an in-flight resize before releasing control", async () => {
    const f = await fixture(), auth = await (await f.post("auth")).json();
    const ws = await f.socket(), ready = message(ws); ws.send(JSON.stringify({ ticket: auth.ticket })); await ready;
    let release!: () => void;
    f.resize.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.post("viewport", { ticket: auth.ticket, viewport: { width: 390, height: 400, desktop: false } });
    await vi.waitFor(() => expect(f.resize).toHaveBeenCalled());
    let ended = false; void f.server.done.then(() => { ended = true; });
    expect((await f.post("finish", { ticket: auth.ticket, mode: "private" })).status).toBe(200);
    expect(ended).toBe(false);
    release(); await pending;
    expect(await f.server.done).toEqual({ status: "handed_back", mode: "private" });
  });
  it("ends privately without releasing credentials when initial sizing fails", async () => {
    const f = await fixture(); f.resize.mockRejectedValueOnce(new Error("synthetic-private-error"));
    const response = await f.post("auth", { viewport: { width: 390, height: 650, desktop: false } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(await f.server.done).toEqual({ status: "failed", mode: "private" });
  });
  it("requires signed paired-user identity and exact origin before returning private connection credentials", async () => {
    const f = await fixture();
    expect((await f.post("auth", { initData: signed(456) })).status).toBe(403);
    expect((await f.post("auth", {}, "https://evil.invalid")).status).toBe(403);
    expect((await f.post("auth", { requestId: "wrong" })).status).toBe(403);
    expect((await f.post("auth", { extra: true })).status).toBe(400);
    const response = await f.post("auth");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ticket: expect.any(String), password: "testOnly" });
    expect(f.connections()).toBe(0);
  });
  it("authenticates before connecting VNC, consumes a ticket once, and revokes the stream before handing back", async () => {
    const f = await fixture(); const auth = await (await f.post("auth")).json();
    const ws = await f.socket(); const frames: Buffer[] = []; ws.on("message", data => frames.push(data as Buffer));
    expect(f.connections()).toBe(0);
    ws.send(JSON.stringify({ ticket: auth.ticket }));
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(JSON.parse(frames[0]!.toString())).toEqual({ ready: true });
    expect(frames[1]!.toString()).toBe("RFB 003.008\n");
    const echoed = message(ws); ws.send(Buffer.from("synthetic-key-input"));
    expect((await echoed).toString()).toBe("synthetic-key-input");
    expect((await f.post("auth")).status).toBe(409);
    const rejected = await f.socket(); const ended = new Promise(r => rejected.once("close", r));
    rejected.send(JSON.stringify({ ticket: auth.ticket })); await ended;
    const closed = new Promise(r => ws.once("close", r));
    expect(await (await f.post("finish", { ticket: auth.ticket, mode: "private" })).json()).toEqual({ status: "handed_back" });
    expect(await f.server.done).toEqual({ status: "handed_back", mode: "private" });
    await closed;
    expect((await f.post("finish", { ticket: auth.ticket, mode: "share" })).status).toBe(410);
  });
  it("rejects foreign websocket origins and invalid tickets without exposing a frame", async () => {
    const f = await fixture(); await expect(f.socket("https://evil.invalid")).rejects.toThrow();
    const ws = await f.socket(); let frames = 0; ws.on("message", () => frames++);
    const closed = new Promise(r => ws.once("close", r)); ws.send(JSON.stringify({ ticket: "wrong" })); await closed;
    expect(frames).toBe(0); expect(f.connections()).toBe(0);
  });
  it("keeps protection after disconnect, allows authenticated reconnect, and expires active streams", async () => {
    const f = await fixture(600);
    const auth = await (await f.post("auth")).json(), ws = await f.socket();
    let returned = false; void f.server.done.then(() => { returned = true; });
    const ready = message(ws); ws.send(JSON.stringify({ ticket: auth.ticket })); await ready;
    const closed = new Promise(r => ws.once("close", r)); ws.close(); await closed;
    expect(returned).toBe(false);
    const next = await (await f.post("auth")).json(); expect(next.ticket).not.toBe(auth.ticket);
    expect((await f.post("finish", { ticket: auth.ticket, mode: "share" })).status).toBe(403);
    expect(await f.server.done).toEqual({ status: "expired", mode: "private" });
  });
  it("supports explicit page sharing and cancellation, hides dependencies outside the static allowlist", async () => {
    const f = await fixture(), auth = await (await f.post("auth")).json();
    expect((await f.post("finish", { ticket: auth.ticket, mode: "share" })).status).toBe(409);
    const ws = await f.socket(), ready = message(ws); ws.send(JSON.stringify({ ticket: auth.ticket })); await ready;
    expect((await f.post("finish", { ticket: auth.ticket, mode: "share" })).status).toBe(200);
    expect(await f.server.done).toEqual({ status: "handed_back", mode: "share" });
    const g = await fixture(); g.controller.abort(); expect(await g.server.done).toEqual({ status: "cancelled", mode: "private" });
    const url = `http://127.0.0.1:${g.server.port}`;
    expect((await fetch(`${url}/novnc/package.json`)).status).toBe(404);
    expect((await fetch(`${url}/novnc/core/rfb.js`)).status).toBe(200);
    expect((await fetch(`${url}/novnc/core/../../../../package.json`)).status).toBe(404);
  });
  it("keeps authenticated private handback available after the public request budget is exhausted", async () => {
    const f = await fixture(), auth = await (await f.post("auth")).json();
    for (let i = 0; i < 245; i++) await fetch(`http://127.0.0.1:${f.server.port}/healthz`);
    expect((await f.post("auth")).status).toBe(429);
    expect((await f.post("finish", { ticket: auth.ticket, mode: "private" })).status).toBe(200);
    expect(await f.server.done).toEqual({ status: "handed_back", mode: "private" });
  });
  it.each(["abort", "expiry"])("revokes an active viewer on %s", async end => {
    const f = await fixture(end === "expiry" ? 400 : 60_000), auth = await (await f.post("auth")).json();
    const ws = await f.socket(), ready = message(ws); ws.send(JSON.stringify({ ticket: auth.ticket })); await ready;
    const closed = new Promise(r => ws.once("close", r));
    if (end === "abort") f.controller.abort();
    expect(await f.server.done).toEqual({ status: end === "abort" ? "cancelled" : "expired", mode: "private" });
    await closed;
  });
  it("holds a refusal-only port during uncertain proxy teardown", async () => {
    const f = await fixture(); f.server.quarantine();
    expect((await fetch(`http://127.0.0.1:${f.server.port}/`)).status).toBe(410);
    expect((await f.post("auth")).status).toBe(410);
    await expect(f.socket()).rejects.toThrow();
    expect(await f.server.done).toEqual({ status: "cancelled", mode: "private" });
  });
});
