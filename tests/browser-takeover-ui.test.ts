import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const script = (await readFile(new URL("../web/browser-takeover/app.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
async function fixture(initData = "signed-synthetic") {
  const elements = new Map<string, any>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: "", disabled: true, textContent: "", hidden: false, addEventListener() {}, focus() {}, blur() {} });
    return elements.get(id);
  };
  const handlers = new Map<string, Function>();
  const sendKey = vi.fn(), disconnect = vi.fn(), close = vi.fn(), disableClosingConfirmation = vi.fn();
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/auth" ? { ticket: "opaque-ticket", password: "testOnly", expiresAt: Date.now() + 60_000, resumeUrl: "https://example.com/" } : { status: "handed_back" } }));
  class Socket {
    handlers = new Map<string, Function>();
    constructor() { setTimeout(() => { this.handlers.get("open")?.(); this.handlers.get("message")?.({ data: '{"ready":true}' }); }, 0); }
    addEventListener(name: string, handler: Function) { this.handlers.set(name, handler); }
    send() {} close() {}
  }
  class RFB { scaleViewport = true; resizeSession = false; dragViewport = false; sendKey = sendKey; disconnect = disconnect;
    addEventListener(name: string, handler: Function) { handlers.set(name, handler); } }
  runInNewContext(script, { RFB, initLogging() {}, KeyTable: { XK_BackSpace: 0xff08, XK_Return: 0xff0d, XK_Tab: 0xff09 },
    window: { Telegram: { WebApp: { initData, ready() {}, expand() {}, enableClosingConfirmation() {}, disableClosingConfirmation, close } } },
    document: { getElementById: el }, location: { hash: "#request=opaque", origin: "https://private.example" },
    fetch, WebSocket: Socket, URLSearchParams, AbortSignal, setTimeout: () => 1, clearTimeout() {},
  });
  await new Promise(r => setTimeout(r, 10)); handlers.get("connect")?.();
  return { el, fetch, sendKey, disconnect, close, disableClosingConfirmation };
}
describe("takeover Mini App", () => {
  it("does not request connection credentials without Telegram identity", async () => {
    const f = await fixture(""); expect(f.fetch).not.toHaveBeenCalled(); expect(f.el("keyboard").disabled).toBe(true);
  });
  it("sends typing only through VNC and requires an explicit handback choice before closing", async () => {
    const f = await fixture();
    f.el("typing").value = "synthetic-password"; f.el("typing").oninput({ isComposing: false });
    expect(f.sendKey).toHaveBeenCalledTimes(18);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.el("handback").onclick(); expect(f.close).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledTimes(1);
    f.el("private").onclick();
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.fetch).toHaveBeenLastCalledWith("/api/finish", expect.objectContaining({ body: JSON.stringify({ requestId: "opaque", initData: "signed-synthetic", ticket: "opaque-ticket", mode: "private" }) }));
    expect(f.el("typing").value).toBe("");
    expect(f.disableClosingConfirmation).toHaveBeenCalledOnce();
  });
  it("keeps the viewer open if handback cannot be confirmed", async () => {
    const f = await fixture(); f.fetch.mockRejectedValueOnce(new Error("network"));
    f.el("share").onclick();
    await vi.waitFor(() => expect(f.el("status").textContent).toContain("Could not confirm"));
    expect(f.close).not.toHaveBeenCalled(); expect(f.el("share").disabled).toBe(false);
  });
});
