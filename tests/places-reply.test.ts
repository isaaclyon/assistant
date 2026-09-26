import { expect, it, vi } from "vitest";
import { PlacesReply } from "../.pi/lib/places-reply.js";

it("only consumes one exact private reply armed by an authorized section", async () => {
  const replies = new PlacesReply();
  const receive = vi.fn(async (_text: string) => {});
  replies.arm({ chatId: 42, messageId: 100 }, receive, "Prompt");
  const message = { message_id: 101, chat: { id: 42, type: "private" }, from: { id: 42 }, reply_to_message: { message_id: 101, from: { is_bot: true }, text: "Prompt" }, text: "Cafe" };
  expect(await replies.handle({ message: { ...message, from: { id: 43 } } })).toBe("pass");
  expect(await replies.handle({ message: { ...message, chat: { id: 42, type: "group" } } })).toBe("pass");
  expect(await replies.handle({ message: { ...message, reply_to_message: { message_id: 99 } } })).toBe("pass");
  expect(await replies.handle({ edited_message: message })).toBe("pass");
  expect(await replies.handle({ message })).toBe("consume");
  expect(await replies.handle({ message })).toBe("pass");
  expect(receive).toHaveBeenCalledExactlyOnceWith("Cafe");
});

it("expires and clears input; refuses group or missing-message arming", async () => {
  let now = 0;
  const replies = new PlacesReply(() => now);
  const receive = vi.fn(async () => {});
  expect(() => replies.arm({ chatId: -42, messageId: 100 }, receive, "Prompt")).toThrow();
  expect(() => replies.arm({ chatId: 42 }, receive, "Prompt")).toThrow();
  replies.arm({ chatId: 42, messageId: 100 }, receive, "Prompt");
  now = 11 * 60_000;
  expect(await replies.handle({ message: { chat: { id: 42, type: "private" }, from: { id: 42 }, reply_to_message: { message_id: 101, from: { is_bot: true }, text: "Prompt" }, text: "Cafe" } })).toBe("pass");
  expect(receive).not.toHaveBeenCalled();
});

it("does not forward claimed text to Pi if editing the result fails", async () => {
  const replies = new PlacesReply();
  replies.arm({ chatId: 42, messageId: 100 }, async () => { throw new Error("Telegram unavailable after save"); }, "Prompt");
  expect(await replies.handle({ message: { chat: { id: 42, type: "private" }, from: { id: 42 }, reply_to_message: { message_id: 101, from: { is_bot: true }, text: "Prompt" }, text: "Cafe" } })).toBe("consume");
});

it("does not treat a delayed reply to an old input as text for a later prompt", async () => {
  const replies = new PlacesReply();
  const receive = vi.fn(async () => {});
  replies.arm({ chatId: 42, messageId: 100 }, receive, "First unique prompt");
  replies.arm({ chatId: 42, messageId: 100 }, receive, "Second unique prompt");
  const message = { chat: { id: 42, type: "private" }, from: { id: 42 }, reply_to_message: { message_id: 101, from: { is_bot: true }, text: "First unique prompt" }, text: "Old notes" };
  expect(await replies.handle({ message })).toBe("pass");
  expect(receive).not.toHaveBeenCalled();
});
