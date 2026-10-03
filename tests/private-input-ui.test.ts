import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = await readFile(new URL("../web/private-input/app.js", import.meta.url), "utf8");
async function fixture(initData = "test-signed-launch", flow = false) {
  type Element = { value: string; disabled: boolean; textContent: string; type: string;
    children: Element[]; handlers: Map<string, (event: { preventDefault(): void }) => Promise<void>>;
    replaceChildren(): void; append(...children: Element[]): void; addEventListener(event: string, handler: (event: { preventDefault(): void }) => Promise<void>): void };
  const element = (): Element => ({ value: "", disabled: true, textContent: "", type: "", children: [], handlers: new Map(),
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); }, addEventListener(event, handler) { this.handlers.set(event, handler); } });
  const elements = new Map(["input", "fields", "status", "submit", "cancel", "destination"].map((id) => [`#${id}`, element()]));
  const payloads: Array<{ url: string; body: string }> = [];
  const close = vi.fn(), disableClosingConfirmation = vi.fn();
  let submissions = 0;
  const fetch = vi.fn(async (url: string, options: { body: string }) => {
    payloads.push({ url, body: options.body });
    if (flow) return { ok: true, json: async () => url.endsWith("auth") ? { status: "pending", origin: "https://www.opentable.com", fields: ["username"], flow: "opentable", step: "email-step" } :
      ++submissions === 1 ? { status: "pending", origin: "https://www.opentable.com", fields: ["code"], flow: "opentable", step: "code-step" } : { status: "submitted" } };
    return { ok: true, json: async () => url.endsWith("auth") ? { status: "pending", origin: "https://example.com", fields: ["password", "code"], step: "single-step" } : { status: "submitted" } };
  });
  runInNewContext(script, {
    window: { Telegram: { WebApp: { initData, ready() {}, expand() {}, enableClosingConfirmation() {}, disableClosingConfirmation, close } }, addEventListener() {} },
    document: { querySelector: (id: string) => elements.get(id), createElement: element },
    location: { hash: "#request=opaque" }, URLSearchParams, AbortSignal, fetch,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const get = (id: string) => elements.get(`#${id}`)!;
  return { get, payloads, fetch, close, disableClosingConfirmation, inputs: () => get("fields").children.filter((child) => child.type === "password"),
    act: (id: string, event: string) => get(id).handlers.get(event)!({ preventDefault() {} }) };
}

describe("private Mini App UI", () => {
  it("requires Telegram launch identity before displaying editable fields", async () => {
    const f = await fixture(""); expect(f.fetch).not.toHaveBeenCalled(); expect(f.get("submit").disabled).toBe(true);
  });
  it("masks secrets, clears the form immediately, and cannot submit twice", async () => {
    const f = await fixture();
    expect(f.inputs()).toHaveLength(2);
    f.inputs()[0]!.value = "synthetic-password"; f.inputs()[1]!.value = "123456";
    const pending = f.act("input", "submit");
    expect(f.inputs().map((input) => input.value)).toEqual(["", ""]);
    expect(f.get("submit").disabled).toBe(true);
    expect(f.close).not.toHaveBeenCalled();
    await pending; await f.act("input", "submit");
    expect(f.payloads.filter((item) => item.url === "/api/submit")).toHaveLength(1);
    expect(JSON.parse(f.payloads[1]!.body).values).toEqual(["synthetic-password", "123456"]);
    expect(f.get("status").textContent).not.toContain("synthetic-password");
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.disableClosingConfirmation.mock.invocationCallOrder[0]).toBeLessThan(f.close.mock.invocationCallOrder[0]!);
  });
  it("cancels without transmitting field contents", async () => {
    const f = await fixture(); f.inputs()[0]!.value = "synthetic-password";
    await f.act("cancel", "click");
    expect(f.payloads[1]!.url).toBe("/api/cancel"); expect(f.payloads[1]!.body).not.toContain("synthetic-password");
    expect(f.inputs()[0]!.value).toBe("");
    expect(f.close).not.toHaveBeenCalled();
  });
  it("replaces each step with empty inputs and binds submissions to that step", async () => {
    const f = await fixture("test-signed-launch", true);
    const email = f.get("fields").children.find((child) => child.type === "email")!;
    email.value = "synthetic@example.invalid";
    await f.act("input", "submit");
    expect(email.value).toBe(""); expect(f.get("fields").children).not.toContain(email);
    expect(f.inputs()).toHaveLength(1); expect(f.inputs()[0]!.value).toBe("");
    expect(f.get("submit").disabled).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
    f.inputs()[0]!.value = "123456"; await f.act("input", "submit");
    expect(f.get("submit").disabled).toBe(true); expect(f.inputs()[0]!.value).toBe("");
    expect(f.payloads.slice(1).map((payload) => JSON.parse(payload.body).step)).toEqual(["email-step", "code-step"]);
    expect(f.get("status").textContent).not.toContain("synthetic@");
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each(["failed", "expired", "cancelled", "http-error", "network-error"])("keeps %s visible instead of closing", async (outcome) => {
    const f = await fixture();
    f.inputs()[0]!.value = "synthetic-password";
    if (outcome === "network-error") f.fetch.mockRejectedValueOnce(new Error("Network unavailable"));
    else f.fetch.mockResolvedValueOnce({ ok: outcome !== "http-error", json: async () => ({ status: outcome }) });
    await f.act("input", "submit");
    expect(f.close).not.toHaveBeenCalled();
    expect(f.get("status").textContent).not.toBe("");
    expect(f.inputs()[0]!.value).toBe("");
    expect(f.disableClosingConfirmation).toHaveBeenCalledOnce();
  });
  it("leaves the completion message available if the Telegram client cannot close", async () => {
    const f = await fixture();
    f.close.mockImplementationOnce(() => { throw new Error("Client cannot close"); });
    await f.act("input", "submit");
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.get("status").textContent).toContain("Sign-in form submitted");
    expect(f.get("submit").disabled).toBe(true);
  });
});
