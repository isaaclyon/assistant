import { afterEach, describe, expect, it } from "vitest";
import { ApprovedCredentialBroker } from "../src/approved-credential-broker.js";
import { ApprovedLoginVault } from "../src/approved-login-vault.js";
import { TrustedTelegramStore } from "../src/trusted-telegram-store.js";
import { TrustedTelegramTransport } from "../src/trusted-telegram-transport.js";

const sourceId = "a".repeat(26), destinationId = "b".repeat(26), itemId = "c".repeat(26), copiedId = "d".repeat(26);
const origin = "https://example.test";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture() {
  const store = new TrustedTelegramStore(":memory:", 42); cleanup.push(() => store.close());
  let now = 1000, reads = 0, writes = 0, ambiguous = false, copy: any;
  const vault = new ApprovedLoginVault({ binary: "/usr/bin/op", tokenFile: "/private/token", home: "/private",
    sourceVault: sourceId, sourceName: "Source", destinationVault: destinationId }, async (args, input) => {
    if (args[1] === "create") { writes++; copy = { ...JSON.parse(input!), id: copiedId, vault: { id: destinationId }, version: 1 };
      if (ambiguous) throw new Error("synthetic lost response"); return copy; }
    if (args[1] === "list") return copy ? [copy] : [];
    if (args[2] === copiedId) return copy;
    reads++;
    return { id: itemId, vault: { id: sourceId }, version: 1, category: "LOGIN", title: "Synthetic login",
      urls: [{ href: origin }], fields: [{ purpose: "USERNAME", value: "synthetic-user" }, { purpose: "PASSWORD", value: "synthetic-secret" }] };
  });
  const telegram = new TrustedTelegramTransport("123:synthetic", store, async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 101 } })));
  const broker = new ApprovedCredentialBroker("personal", store, vault, telegram, () => now);
  return { store, broker, counts: () => ({ reads, writes }), ambiguous: () => { ambiguous = true; },
    advance: () => { now += 250_000; },
    decide: (id: string, choice: string) => store.ingest([{ update_id: 1, callback_query: { id: "decision", from: { id: 42 },
      message: { message_id: 101, chat: { id: 42, type: "private" } }, data: `credential-approval:${id}:${choice}` } }], now),
    request: async () => (await (await broker.call("credentialRequest", { itemId, origin, purpose: "Check account" })).json()).requestId as string,
  };
}

describe("approved credential broker", () => {
  it("requires a real bound decision and releases a Once credential only once", async () => {
    const f = fixture(), requestId = await f.request();
    expect(f.counts()).toEqual({ reads: 1, writes: 0 });
    expect((await f.broker.call("credentialConsume", { requestId, origin, approved: true })).status).toBe(403);
    expect((await f.broker.call("credentialConsume", { requestId, origin })).status).toBe(403);
    f.decide(requestId, "once");
    expect((await f.broker.call("credentialConsume", { requestId, origin: "https://other.test" })).status).toBe(403);
    const response = await f.broker.call("credentialConsume", { requestId, origin });
    expect(await response.json()).toEqual({ ok: true, credential: { username: "synthetic-user", password: "synthetic-secret" } });
    expect(f.counts()).toEqual({ reads: 2, writes: 0 });
    expect((await f.broker.call("credentialConsume", { requestId, origin })).status).toBe(403);
    expect(JSON.stringify(await (await f.broker.call("credentialStatus", { requestId, origin })).json())).not.toContain("synthetic-secret");
  });
  it("does not resolve for delivery or copy after denial or expiry", async () => {
    for (const choice of ["deny", "expiry"]) {
      const f = fixture(), requestId = await f.request();
      if (choice === "deny") f.decide(requestId, "deny"); else f.advance();
      expect((await f.broker.call("credentialConsume", { requestId, origin })).status).toBe(403);
      expect(f.counts()).toEqual({ reads: 1, writes: 0 });
    }
  });
  it("records the independent copy separately from browser delivery", async () => {
    const f = fixture(), requestId = await f.request(); f.decide(requestId, "always");
    expect((await f.broker.call("credentialConsume", { requestId, origin })).status).toBe(200);
    expect(await (await f.broker.call("credentialStatus", { requestId, origin })).json()).toEqual({ ok: true, state: "delivered", copiedItem: copiedId });
    expect(f.counts().writes).toBe(1);
  });
  it("reconciles a lost create response without writing or releasing again", async () => {
    const f = fixture(), requestId = await f.request(); f.decide(requestId, "always"); f.ambiguous();
    expect((await f.broker.call("credentialConsume", { requestId, origin })).status).toBe(403);
    expect(await (await f.broker.call("credentialReconcile", { requestId, origin })).json()).toEqual({ ok: true, state: "uncertain", copiedItem: copiedId });
    expect((await f.broker.call("credentialConsume", { requestId, origin })).status).toBe(403);
    expect(f.counts().writes).toBe(1);
  });
  it("rejects caller-selected destinations and arbitrary approval fields", async () => {
    const f = fixture();
    expect((await f.broker.call("credentialRequest", { itemId, origin, purpose: "Check account", destinationVault: "other" })).status).toBe(403);
    expect(f.counts()).toEqual({ reads: 0, writes: 0 });
  });
});
