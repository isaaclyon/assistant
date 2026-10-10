import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateApprovedCredential } from "../src/private-approved-credential.js";

const requestId = "a".repeat(24), origin = "https://example.test";
beforeEach(() => vi.stubEnv("PI_TELEGRAM_TRUSTED_SOCKET", "/synthetic/broker.sock"));
afterEach(() => vi.unstubAllEnvs());
function transport(choice: string, consume: () => unknown = () => ({ credential: { username: "synthetic-user", password: "synthetic-secret" } }), copiedItem?: string) {
  return vi.fn<typeof fetch>(async input => {
    const method = new URL(String(input)).pathname.split("/").at(-1);
    const result = method === "credentialRequest" ? { requestId, expiresAt: Date.now() + 10_000 } :
      method === "credentialStatus" ? { state: choice } : method === "credentialConsume" ? consume() : { copiedItem };
    return new Response(JSON.stringify({ ok: true, ...result as object }));
  });
}
describe("protected approval client", () => {
  it("returns one private credential after a decision, without another consume call", async () => {
    const fetch = transport("once");
    expect(await privateApprovedCredential("b".repeat(26), origin, "Check account", new AbortController().signal, fetch))
      .toEqual({ status: "approved", credential: { username: "synthetic-user", password: "synthetic-secret" } });
    expect(fetch.mock.calls.map(call => String(call[0]).split("/").at(-1))).toEqual(["credentialRequest", "credentialStatus", "credentialConsume"]);
  });
  it.each(["denied", "expired"])("does not consume after %s", async status => {
    const fetch = transport(status);
    expect(await privateApprovedCredential("b".repeat(26), origin, "Check account", new AbortController().signal, fetch)).toEqual({ status });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("reconciles an ambiguous Always write without retrying delivery", async () => {
    const copiedItem = "c".repeat(26);
    const fetch = transport("always", () => { throw new Error("private transport detail"); }, copiedItem);
    expect(await privateApprovedCredential("b".repeat(26), origin, "Check account", new AbortController().signal, fetch))
      .toEqual({ status: "unavailable", copiedItem });
    expect(fetch.mock.calls.filter(call => String(call[0]).endsWith("/credentialConsume"))).toHaveLength(1);
  });
  it("reports copy uncertainty when read-only reconciliation cannot establish a copy", async () => {
    const fetch = transport("always", () => { throw new Error("private transport detail"); });
    expect(await privateApprovedCredential("b".repeat(26), origin, "Check account", new AbortController().signal, fetch))
      .toEqual({ status: "unavailable", copyStatus: "unknown" });
  });
  it("cancels the outstanding request when the protected operation is aborted", async () => {
    const controller = new AbortController(), fetch = transport("pending");
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, requestId, expiresAt: Date.now() + 10_000 })));
    fetch.mockImplementationOnce(async () => { controller.abort(); return new Response(JSON.stringify({ ok: true, state: "pending" })); });
    expect(await privateApprovedCredential("b".repeat(26), origin, "Check account", controller.signal, fetch)).toEqual({ status: "cancelled" });
    expect(String(fetch.mock.calls.at(-1)![0])).toContain("/credentialCancel");
    expect(fetch.mock.calls.at(-1)![1]!.signal!.aborted).toBe(false);
  });
});
