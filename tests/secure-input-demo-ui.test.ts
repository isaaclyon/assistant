import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = await readFile(new URL("../web/secure-input-demo/app.js", import.meta.url), "utf8");
async function page(initData = "signed-test-data") {
  const elements = new Map<string, {
    disabled: boolean; value: string; textContent: string;
    listeners: Map<string, (event: { preventDefault(): void }) => Promise<void>>;
    addEventListener(event: string, callback: (event: { preventDefault(): void }) => Promise<void>): void;
  }>();
  for (const id of ["status", "demo", "code", "submit", "cancel"]) {
    elements.set(`#${id}`, { disabled: true, value: "", textContent: "", listeners: new Map(),
      addEventListener(event, callback) { this.listeners.set(event, callback); } });
  }
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => ({
    status: url.endsWith("auth") ? "pending" : url.endsWith("submit") ? "completed" : "cancelled",
  }) }));
  runInNewContext(source, {
    document: { querySelector: (id: string) => elements.get(id) },
    window: { Telegram: { WebApp: { initData, ready() {}, expand() {}, enableClosingConfirmation() {}, disableClosingConfirmation() {} } } },
    location: { hash: "#request=dummy-request" }, URLSearchParams, AbortSignal, fetch,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { fetch, get: (id: string) => elements.get(`#${id}`)!,
    act: async (id: string, event: string) => { await elements.get(`#${id}`)!.listeners.get(event)!({ preventDefault() {} }); } };
}

describe("private form UI", () => {
  it("keeps an ordinary browser disabled without Telegram launch data", async () => {
    const ui = await page("");
    expect(ui.fetch).not.toHaveBeenCalled();
    expect(ui.get("submit").disabled).toBe(true);
    expect(ui.get("status").textContent).toContain("private Telegram bot chat");
  });
  it("blocks arbitrary input locally and submits only the literal sample", async () => {
    const ui = await page();
    expect(ui.get("submit").disabled).toBe(false);
    ui.get("code").value = "private-value";
    await ui.act("demo", "submit");
    expect(ui.fetch).toHaveBeenCalledTimes(1); // identity check only
    ui.get("code").value = "123456";
    await ui.act("demo", "submit");
    expect(ui.fetch).toHaveBeenLastCalledWith("/api/submit", expect.objectContaining({
      body: JSON.stringify({ requestId: "dummy-request", initData: "signed-test-data", code: "123456" }),
    }));
    expect(ui.get("status").textContent).toContain("Success!");
    expect(ui.get("code").value).toBe("");
    expect(ui.get("submit").disabled).toBe(true);
  });
  it("cancels without transmitting the field value", async () => {
    const ui = await page();
    ui.get("code").value = "private-value";
    await ui.act("cancel", "click");
    expect(ui.fetch).toHaveBeenLastCalledWith("/api/cancel", expect.objectContaining({
      body: JSON.stringify({ requestId: "dummy-request", initData: "signed-test-data" }),
    }));
    expect(ui.get("code").value).toBe("");
    expect(ui.get("status").textContent).toContain("Cancelled");
  });
});
