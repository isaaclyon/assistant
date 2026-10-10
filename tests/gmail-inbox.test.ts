import { describe, expect, it, vi } from "vitest";
import { observeGmailInbox, parseGmailInboxArgs } from "../src/checkers/gmail-inbox.js";

const args = { account: "personal", timeZone: "America/New_York" };
const message = (id: string, second: number) => ({ id, threadId: "abc", internalDateIso: new Date(second * 1000).toISOString(), from: "Someone", subject: "Action", body: "Please review", labels: ["INBOX"] });

describe("incremental Gmail inbox", () => {
  it("starts with an empty baseline without fetching old mail", async () => {
    const search = vi.fn();
    const result = await observeGmailInbox(args, null, search, 1000_000);
    expect(search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ version: 2, value: { items: [] }, cursor: { since: 1000 } });
  });

  it("keeps a fixed window across pages and deduplicates message IDs", async () => {
    const search = vi.fn().mockResolvedValueOnce({ messages: [message("a1", 1010)], nextPageToken: "page2" })
      .mockResolvedValueOnce({ messages: [message("a1", 1010), message("a2", 1020)], nextPageToken: "" });
    const first = await observeGmailInbox(args, { since: 1000 }, search, 1600_000);
    expect(first.value.items).toHaveLength(1);
    expect(first.cursor).toMatchObject({ since: 1000, until: 1480, page: "page2", seen: ["a1"] });
    const second = await observeGmailInbox(args, first.cursor, search, 2200_000);
    expect(search.mock.calls[1]?.[0]).toContain("before:1480");
    expect(second.value.items.map((item) => item.id)).toEqual(["a2"]);
    expect(second.cursor).toEqual({ since: 1480 });
  });

  it("uses internal delivery times, retains exact boundary messages, and bounds untrusted bodies", async () => {
    const search = vi.fn().mockResolvedValue({ messages: [message("old", 999), { ...message("new", 1000), body: "é".repeat(9000) }], nextPageToken: "" });
    const result = await observeGmailInbox(args, { since: 1000 }, search, 1600_000);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]).toMatchObject({ id: "new", untrusted: true, truncated: true, account: "personal", checkedAt: "1970-01-01T00:26:40.000Z" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
  });

  it("fails on partial/malformed responses and does not mutate the supplied cursor", async () => {
    const cursor = { since: 1000 };
    for (const payload of [{}, { messages: [{}] }, { messages: null }, { messages: [], nextPageToken: 123 }]) {
      await expect(observeGmailInbox(args, cursor, async () => payload, 1600_000)).rejects.toThrow();
    }
    expect(cursor).toEqual({ since: 1000 });
  });

  it("validates account, timezone and cursor, and waits for indexing before advancing", async () => {
    expect(() => parseGmailInboxArgs('{"account":"--bad","timeZone":"UTC"}')).toThrow();
    expect(() => parseGmailInboxArgs('{"account":"personal","timeZone":"bad"}')).toThrow();
    await expect(observeGmailInbox(args, { since: "invalid" }, vi.fn(), 1600_000)).rejects.toThrow();
    const search = vi.fn();
    expect((await observeGmailInbox(args, { since: 1500 }, search, 1600_000)).cursor).toEqual({ since: 1500 });
    expect(search).not.toHaveBeenCalled();
  });
});
