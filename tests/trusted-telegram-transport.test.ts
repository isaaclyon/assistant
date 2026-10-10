import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrustedTelegramStore, type CredentialApprovalDetails } from "../src/trusted-telegram-store.js";
import { TrustedTelegramTransport } from "../src/trusted-telegram-transport.js";
import { serveTrustedTelegram, trustedTelegramFetch } from "../src/trusted-telegram-ipc.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const message = (id: number) => ({ message_id: id, chat: { id: 42, type: "private" }, from: { id: 42 } });
const details: CredentialApprovalDetails = { instance: "personal", itemId: "synthetic-item", vaultId: "synthetic-vault",
  itemVersion: 1, title: "Example login", username: "user@example.test", vaultName: "Eligible logins",
  origin: "https://example.test", purpose: "Read account status" };
function fixture() {
  const store = new TrustedTelegramStore(":memory:", 42); cleanups.push(() => store.close());
  let updates: unknown[] = [];
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const method = new URL(String(input)).pathname.split("/").at(-1);
    const fields = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const result = method === "getUpdates" ? updates : method === "getFile"
      ? { file_id: fields.file_id, file_path: "photos/synthetic.jpg" }
      : method === "getMe" ? { id: 100, is_bot: true } : method?.startsWith("send") ? message(101) : true;
    return new Response(JSON.stringify({ ok: true, result }));
  });
  return { store, upstream, transport: new TrustedTelegramTransport("123:synthetic", store, upstream),
    setUpdates: (value: unknown[]) => { updates = value; } };
}

describe("trusted Telegram transport", () => {
  it("keeps polling and approval callbacks outside the runtime proxy", async () => {
    const { store, transport, upstream, setUpdates } = fixture();
    const id = await transport.showApproval(details, 1000);
    expect((await transport.runtimeCall("editMessageText", { chat_id: 42, message_id: 101, text: "forged" })).status).toBe(403);
    expect((await transport.runtimeCall("deleteWebhook", { drop_pending_updates: true })).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    setUpdates([{ update_id: 1, callback_query: { id: "choice", from: { id: 42 }, message: message(101),
      data: `credential-approval:${id}:once` } }, { update_id: 2, message: message(102) }]);
    await transport.pollOnce(() => 2000);
    expect(store.pollOffset).toBe(3);
    expect(store.claimApproval(id, 2001)?.state).toBe("once");
    const queued = await (await transport.runtimeCall("getUpdates", { offset: 0 })).json();
    expect(queued.result).toEqual([{ update_id: 2, message: message(102) }]);
    expect((await transport.runtimeCall("answerCallbackQuery", { callback_query_id: "choice" })).status).toBe(403);
  });

  it("rolls back unsorted Telegram batches rather than silently losing input", () => {
    const { store } = fixture();
    expect(() => store.ingest([{ update_id: 2, message: message(2) }, { update_id: 1, message: message(1) }], 1)).toThrow(/ordered/);
    expect(store.pollOffset).toBe(0);
    expect(store.ownsMessage(2)).toBe(false);
  });

  it("requires received file ownership before resolving a download path", async () => {
    const { transport, store, upstream } = fixture();
    expect((await transport.runtimeCall("getFile", { file_id: "unknown" })).status).toBe(403);
    expect((await transport.download("photos/synthetic.jpg")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    store.ingest([{ update_id: 1, message: { ...message(2), photo: [{ file_id: "received" }] } }], 1);
    expect((await transport.runtimeCall("getFile", { file_id: "received" })).status).toBe(200);
    expect(store.ownsFilePath("photos/synthetic.jpg")).toBe(true);
    expect((await transport.download("photos/synthetic.jpg")).status).toBe(200);
  });

  it("carries JSON and uploads over a protected socket and records editable sent messages", async () => {
    const { transport, store, upstream } = fixture();
    const directory = await mkdtemp(join(tmpdir(), "telegram-ipc-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const socket = join(directory, "broker.sock");
    const server = await serveTrustedTelegram(socket, transport);
    cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    const proxy = trustedTelegramFetch(socket);
    const identity = await proxy("https://api.telegram.org/bot0:surrogate/getMe");
    expect(await identity.json()).toEqual({ ok: true, result: { id: 100, is_bot: true } });
    const form = new FormData(); form.set("chat_id", "42"); form.set("photo", new Blob(["synthetic"]), "test.txt");
    expect((await proxy("https://api.telegram.org/bot0:surrogate/sendPhoto", { method: "POST", body: form })).status).toBe(200);
    expect(store.ownsMessage(101)).toBe(true);
    expect(upstream.mock.calls.at(-1)?.[1]?.body).toBeInstanceOf(FormData);
    expect((await proxy("https://api.telegram.org/bot0:surrogate/editMessageText", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: 42, message_id: 101, text: "updated" }) })).status).toBe(200);
    await expect(proxy("https://other.test/bot0:surrogate/getMe")).rejects.toThrow(/Invalid/);
    expect((await proxy("https://api.telegram.org/bot0:surrogate/setWebhook", { method: "POST", body: "{}" })).status).toBe(403);
  });
});
