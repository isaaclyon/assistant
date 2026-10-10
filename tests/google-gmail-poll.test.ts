import { describe, expect, it, vi } from "vitest";
import { readGmailInboxPage } from "../.pi/lib/google-gmail-poll.js";

const runtime = { binary: "/bin/gog", passwordFile: "/private/key", gogHome: "/private/google" };
const response = (id = "a1", labels = ["INBOX"]) => ({ message: { id, threadId: "b1", internalDate: "1000000", labelIds: labels, headers: { from: "Someone", subject: "Hello" }, body: "Hello" } });

describe("closed Gmail polling adapter", () => {
  it("uses bounded readonly commands and internal delivery times instead of sender dates", async () => {
    const run = vi.fn().mockResolvedValueOnce({ messages: [{ id: "a1", date: "misleading" }], nextPageToken: "p2" }).mockResolvedValueOnce(response());
    const result = await readGmailInboxPage(runtime, "personal", "in:inbox after:1 before:2", undefined, run);
    expect(result).toMatchObject({ messages: [{ id: "a1", internalDateIso: "1970-01-01T00:16:40.000Z" }], nextPageToken: "p2" });
    for (const [call] of run.mock.calls) {
      expect(call.args).toEqual(expect.arrayContaining(["--readonly", "--gmail-no-send", "--wrap-untrusted", "--no-input", "--account", "personal"]));
      expect(call.timeoutMs).toBe(20000);
    }
    expect(run.mock.calls[1]?.[0].args).toEqual(expect.arrayContaining(["get", "a1", "--sanitize-content"]));
  });

  it("drops messages archived since search but fails a missing or malformed message", async () => {
    const run = vi.fn().mockResolvedValueOnce({ messages: [{ id: "a1" }] }).mockResolvedValueOnce(response("a1", []));
    expect((await readGmailInboxPage(runtime, "work", "in:inbox after:1 before:2", undefined, run)).messages).toEqual([]);
    run.mockResolvedValueOnce({ messages: [{ id: "a1" }] }).mockRejectedValueOnce(new Error("unavailable"));
    await expect(readGmailInboxPage(runtime, "work", "in:inbox after:1 before:2", undefined, run)).rejects.toThrow();
    run.mockResolvedValueOnce({ messages: [{ id: "a1" }] }).mockResolvedValueOnce(response("wrong"));
    await expect(readGmailInboxPage(runtime, "work", "in:inbox after:1 before:2", undefined, run)).rejects.toThrow();
  });

  it("rejects arbitrary queries, accounts and message flags before using them", async () => {
    const run = vi.fn().mockResolvedValue({ messages: [{ id: "--bad" }] });
    await expect(readGmailInboxPage(runtime, "--bad", "in:inbox after:1 before:2", undefined, run)).rejects.toThrow();
    await expect(readGmailInboxPage(runtime, "work", "in:anywhere", undefined, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(readGmailInboxPage(runtime, "work", "in:inbox after:1 before:2", undefined, run)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
