import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = await readFile(new URL("../web/private-input/app.js", import.meta.url), "utf8");
async function fixture(initData = "test-signed-launch") {
  type Element = { value: string; disabled: boolean; textContent: string; type: string;
    children: Element[]; handlers: Map<string, (event: { preventDefault(): void }) => Promise<void>>;
    append(...children: Element[]): void; addEventListener(event: string, handler: (event: { preventDefault(): void }) => Promise<void>): void };
  const element = (): Element => ({ value: "", disabled: true, textContent: "", type: "", children: [], handlers: new Map(),
    append(...children) { this.children.push(...children); }, addEventListener(event, handler) { this.handlers.set(event, handler); } });
  const elements = new Map(["input", "fields", "status", "submit", "cancel", "destination"].map((id) => [`#${id}`, element()]));
  const payloads: Array<{ url: string; body: string }> = [];
  const fetch = vi.fn(async (url: string, options: { body: string }) => {
    payloads.push({ url, body: options.body });
    return { ok: true, json: async () => url.endsWith("auth") ? { status: "pending", origin: "https://example.com", fields: ["password", "code"] } : { status: "submitted" } };
  });
  runInNewContext(script, {
    window: { Telegram: { WebApp: { initData, ready() {}, expand() {}, enableClosingConfirmation() {}, disableClosingConfirmation() {} } }, addEventListener() {} },
    document: { querySelector: (id: string) => elements.get(id), createElement: element },
    location: { hash: "#request=opaque" }, URLSearchParams, AbortSignal, fetch,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const get = (id: string) => elements.get(`#${id}`)!;
  return { get, payloads, fetch, inputs: () => get("fields").children.filter((child) => child.type === "password"),
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
    await pending; await f.act("input", "submit");
    expect(f.payloads.filter((item) => item.url === "/api/submit")).toHaveLength(1);
    expect(JSON.parse(f.payloads[1]!.body).values).toEqual(["synthetic-password", "123456"]);
    expect(f.get("status").textContent).not.toContain("synthetic-password");
  });
  it("cancels without transmitting field contents", async () => {
    const f = await fixture(); f.inputs()[0]!.value = "synthetic-password";
    await f.act("cancel", "click");
    expect(f.payloads[1]!.url).toBe("/api/cancel"); expect(f.payloads[1]!.body).not.toContain("synthetic-password");
    expect(f.inputs()[0]!.value).toBe("");
  });
});
