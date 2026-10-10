import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrustedTelegramStore, type CredentialApprovalDetails } from "../src/trusted-telegram-store.js";

const details: CredentialApprovalDetails = { instance: "personal", itemId: "synthetic-item", vaultId: "synthetic-vault",
  itemVersion: 1, title: "Example login", username: "user@example.test", vaultName: "Eligible logins",
  origin: "https://example.test", purpose: "Read account status" };
const message = (id: number) => ({ message_id: id, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "hello" });
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function store() { const result = new TrustedTelegramStore(":memory:", 42); cleanup.push(() => result.close()); return result; }
function callback(updateId: number, approvalId: string, choice = "once") {
  return { update_id: updateId, callback_query: { id: `callback-${updateId}`, from: { id: 42 },
    message: message(101), data: `credential-approval:${approvalId}:${choice}` } };
}

describe("trusted Telegram durable ownership", () => {
  it("consumes decisions outside the runtime queue and permits one credential claim", () => {
    const db = store(), approval = db.createApproval(details, 1000);
    db.bindApprovalMessage(approval.id, 101);
    expect(db.ingest([callback(10, approval.id)], 2000)).toEqual(["callback-10"]);
    expect(db.readUpdates(0)).toEqual([]);
    expect(db.ownsMessage(101)).toBe(false);
    expect(db.ownsCallback("callback-10")).toBe(false);
    expect(db.claimApproval(approval.id, 2001)?.state).toBe("once");
    db.ingest([callback(11, approval.id, "always")], 2002);
    expect(db.claimApproval(approval.id, 2003)).toBeUndefined();
    db.finishApproval(approval.id, "delivered");
    expect(db.approval(approval.id, 2004)?.state).toBe("delivered");
  });
  it("rejects the wrong user, chat, message, unknown choices and expired decisions", () => {
    const db = store(), approval = db.createApproval(details, 1000);
    db.bindApprovalMessage(approval.id, 101);
    const wrongUser = callback(1, approval.id); wrongUser.callback_query.from.id = 7;
    const wrongChat = callback(2, approval.id); wrongChat.callback_query.message.chat.id = 7;
    const wrongMessage = callback(3, approval.id); wrongMessage.callback_query.message.message_id = 102;
    db.ingest([wrongUser, wrongChat, wrongMessage, callback(4, approval.id, "true")], 2000);
    expect(db.approval(approval.id, 2000)?.state).toBe("pending");
    db.ingest([callback(5, approval.id)], approval.expiresAt);
    expect(db.claimApproval(approval.id, approval.expiresAt)).toBeUndefined();
    expect(db.approval(approval.id, approval.expiresAt)?.state).toBe("expired");
  });
  it("denial cannot be overwritten or claimed", () => {
    const db = store(), approval = db.createApproval(details, 1000);
    db.bindApprovalMessage(approval.id, 101);
    db.ingest([callback(1, approval.id, "deny"), callback(2, approval.id)], 2000);
    expect(db.approval(approval.id, 2000)?.state).toBe("denied");
    expect(db.claimApproval(approval.id, 2000)).toBeUndefined();
  });
  it("persists ordinary input before advancing the single Telegram offset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trusted-telegram-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "state.db");
    let db = new TrustedTelegramStore(path, 42);
    const update = { update_id: 10, message: message(99) };
    db.ingest([update], 1000);
    expect(db.pollOffset).toBe(11); db.close();
    db = new TrustedTelegramStore(path, 42); cleanup.push(() => db.close());
    expect(db.pollOffset).toBe(11);
    expect(() => db.readUpdates(11)).toThrow(); // Cannot acknowledge an unoffered update.
    expect(db.readUpdates(0)).toEqual([update]);
    expect(db.readUpdates(0)).toEqual([update]); // Lost response remains replayable.
    expect(db.ownsMessage(99)).toBe(true);
    expect(db.readUpdates(11)).toEqual([]);
    expect(() => new TrustedTelegramStore(path, 43)).toThrow(/another user/);
  });
  it("retains consuming state across restart rather than releasing again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trusted-approval-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "state.db"); let db = new TrustedTelegramStore(path, 42);
    const approval = db.createApproval(details, 1000); db.bindApprovalMessage(approval.id, 101);
    db.ingest([callback(1, approval.id, "always")], 2000);
    expect(db.claimApproval(approval.id, 2001)?.state).toBe("always"); db.close();
    db = new TrustedTelegramStore(path, 42); cleanup.push(() => db.close());
    expect(db.claimApproval(approval.id, 2002)).toBeUndefined();
    expect(db.approval(approval.id, 2002)?.state).toBe("consuming");
  });
  it("rolls back the entire update batch on malformed evidence", () => {
    const db = store();
    expect(() => db.ingest([{ update_id: 1, message: message(99) }, { update_id: "bad" }], 1000)).toThrow();
    expect(db.pollOffset).toBe(0); expect(db.ownsMessage(99)).toBe(false);
    expect(db.readUpdates(0)).toEqual([]);
  });
});
