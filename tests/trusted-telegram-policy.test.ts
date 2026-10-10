import { describe, expect, it } from "vitest";
import { authorizeRuntimeTelegramCall } from "../src/trusted-telegram-policy.js";

const policy = {
  userId: 42,
  ownsMessage: (id: number) => id === 100,
  ownsCallback: (id: string) => id === "ordinary-callback",
};

describe("trusted Telegram transport policy", () => {
  it("allows ordinary traffic only to the paired private user", () => {
    expect(authorizeRuntimeTelegramCall(policy, "sendMessage", { chat_id: 42, text: "Hello" })).toBe(true);
    expect(authorizeRuntimeTelegramCall(policy, "sendMessage", { chat_id: "42", text: "Hello" })).toBe(true);
    for (const chat_id of [7, -42, "@anotheruser", "42x", 42.5, "0042", null]) {
      expect(authorizeRuntimeTelegramCall(policy, "sendMessage", { chat_id, text: "Hello" })).toBe(false);
    }
  });
  it("cannot edit or delete trusted approval messages, even with a guessed ID", () => {
    for (const method of ["editMessageText", "deleteMessage"]) {
      const content = method === "editMessageText" ? { text: "hello" } : {};
      expect(authorizeRuntimeTelegramCall(policy, method, { chat_id: 42, message_id: 100, ...content })).toBe(true);
      expect(authorizeRuntimeTelegramCall(policy, method, { chat_id: 42, message_id: 101, ...content })).toBe(false);
      expect(authorizeRuntimeTelegramCall(policy, method, { chat_id: 42, message_id: 100, inline_message_id: "other" })).toBe(false);
    }
  });
  it("cannot acknowledge approval callbacks or mint their callback namespace", () => {
    expect(authorizeRuntimeTelegramCall(policy, "answerCallbackQuery", { callback_query_id: "ordinary-callback" })).toBe(true);
    expect(authorizeRuntimeTelegramCall(policy, "answerCallbackQuery", { callback_query_id: "trusted-callback" })).toBe(false);
    expect(authorizeRuntimeTelegramCall(policy, "sendMessage", { chat_id: 42, text: "hello", reply_markup: {
      inline_keyboard: [[{ text: "Allow", callback_data: "credential-approval:fake:once" }]],
    } })).toBe(false);
    expect(authorizeRuntimeTelegramCall(policy, "sendMessage", { chat_id: 42, text: "hello", reply_markup: JSON.stringify({
      inline_keyboard: [[{ text: "Allow", callback_data: "credential-approval:fake:once" }]],
    }) })).toBe(false);
  });
  it("denies authority-changing, arbitrary, bulk and cross-chat methods", () => {
    for (const method of ["setWebhook", "logOut", "close", "deleteMessages", "forwardMessage", "copyMessage", "sendInvoice", "setChatAdministratorCustomTitle", "unknown"]) {
      expect(authorizeRuntimeTelegramCall(policy, method, { chat_id: 42 })).toBe(false);
    }
    expect(authorizeRuntimeTelegramCall(policy, "sendMessage", { chat_id: 42, business_connection_id: "elsewhere" })).toBe(false);
    expect(authorizeRuntimeTelegramCall(policy, "setMyCommands", { commands: [], scope: { type: "chat", chat_id: 7 } })).toBe(false);
    expect(authorizeRuntimeTelegramCall(policy, "setMyCommands", { commands: [], scope: { type: "chat", chat_id: 42 } })).toBe(true);
  });
  it("rejects malformed bodies and nested reply markup rather than passing them through", () => {
    for (const body of [null, [], "json", { chat_id: 42, reply_markup: "{" },
      { chat_id: 42, reply_markup: { inline_keyboard: [[{ text: "bad", callback_data: 2 }]] } }]) {
      expect(authorizeRuntimeTelegramCall(policy, "sendMessage", body)).toBe(false);
    }
  });
});
