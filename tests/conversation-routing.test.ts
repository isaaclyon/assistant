import { describe, expect, it, vi } from "vitest";
import { buildConversationRoutingRequest, lastTelegramMessageTime, shouldStartNewConversation } from "../src/conversation-routing.js";

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("Jev conversation routing", () => {
  it("bootstraps the clock only from human Telegram history", () => {
    expect(lastTelegramMessageTime([
      { type: "message", message: { role: "user", content: "[telegram] hello", timestamp: 123000 } },
      { type: "message", message: { role: "user", content: "[scheduled job] run", timestamp: 456000 } },
    ])).toBe(123000);
  });
  it("selects the original human message and last two conversational messages from the full branch", () => {
    const request = buildConversationRoutingRequest([
      user("[scheduled job] unrelated"), user("[telegram] help with coffee"),
      assistant("Which grinder?"), { type: "compaction", summary: "summary" },
      user("[telegram|thread:Maple] mine"),
      { type: "message", message: { role: "toolResult", content: "private tool result" } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "tool" }] } },
      assistant("Try a finer grind."),
    ], "That worked, thanks!");
    expect(request?.state).toEqual({
      first_user_message: "[telegram] help with coffee",
      recent_messages: [{ role: "user", text: "[telegram|thread:Maple] mine" }, { role: "assistant", text: "Try a finer grind." }],
      incoming_user_message: "That worked, thanks!",
    });
  });

  it("skips empty histories and attachment-only incoming turns", () => {
    expect(buildConversationRoutingRequest([], "hello")).toBeUndefined();
    expect(buildConversationRoutingRequest([user("[telegram] hi")], "[attachments]\n/tmp/photo.jpg")).toBeUndefined();
  });

  it("bounds each text and removes attachment/handler metadata", () => {
    const request = buildConversationRoutingRequest([user("[telegram] " + "a".repeat(10000)), assistant("fine")], "hello\n\n[attachments]\n/private/path");
    expect(String(request?.state.first_user_message).length).toBeLessThanOrEqual(4096);
    expect(request?.state.incoming_user_message).toBe("hello");
  });

  it.each([[0.02, true], [0.299, true], [0.3, false], [0.5, false], [0.99, false]])("routes probability %s", async (probability, expected) => {
    const judge = vi.fn(async () => ({ model: "jev-1.13.0", probabilities: { same_conversation: probability } }));
    await expect(shouldStartNewConversation([user("[telegram] hi")], "hello", judge)).resolves.toBe(expected);
    expect(judge).toHaveBeenCalledOnce();
  });
});
