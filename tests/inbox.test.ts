import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openInbox, type InboundInbox } from "../src/inbox.js";

describe("openInbox", () => {
  let root: string;
  let inbox: InboundInbox;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inbox-test-"));
    inbox = openInbox(join(root, "inbox.db"));
  });

  afterEach(async () => {
    inbox.close();
    await rm(root, { recursive: true, force: true });
  });

  it("persists and returns pending turns in enqueue order", () => {
    inbox.persist("100:30", "c", 3);
    inbox.persist("100:10", "a", 1);
    inbox.persist("100:20", "b", 2);

    expect(inbox.loadPending()).toEqual([
      { id: "100:10", payload: "a" },
      { id: "100:20", payload: "b" },
      { id: "100:30", payload: "c" },
    ]);
  });

  it("ignores a duplicate turn id instead of overwriting or erroring", () => {
    inbox.persist("7:42", "original", 1);
    inbox.persist("7:42", "redelivered", 2);

    expect(inbox.loadPending()).toEqual([{ id: "7:42", payload: "original" }]);
  });

  it("removes a turn once it has been handed to Pi", () => {
    inbox.persist("7:1", "x", 1);
    inbox.persist("7:2", "y", 2);

    inbox.remove("7:1");

    expect(inbox.loadPending()).toEqual([{ id: "7:2", payload: "y" }]);
  });

  it("treats removing an absent turn as a no-op", () => {
    inbox.persist("7:1", "x", 1);

    expect(() => inbox.remove("7:999")).not.toThrow();
    expect(inbox.loadPending()).toEqual([{ id: "7:1", payload: "x" }]);
  });

  it("preserves opaque payloads verbatim, including serialized JSON", () => {
    const payload = JSON.stringify({ content: [{ text: "héllo" }], threadId: 7 });
    inbox.persist("7:5", payload, 100);

    expect(inbox.loadPending()[0]?.payload).toBe(payload);
  });

  it("survives reopening the same database file", () => {
    inbox.persist("7:7", "durable", 1);
    inbox.close();

    const reopened = openInbox(join(root, "inbox.db"));
    try {
      expect(reopened.loadPending()).toEqual([{ id: "7:7", payload: "durable" }]);
    } finally {
      reopened.close();
    }
  });
});
