import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

describe("fresh-session menu handoff", () => {
  it("opens the start controls with the fresh context in the originating thread", async () => {
    const source = readFileSync(resolveTelegramExtensionPath(), "utf8");
    const callback = source.match(/async sendTargetText\(target, text\) \{[\s\S]*?\n      \},/)?.[0];
    expect(callback).toBeDefined();
    const sendTextReply = vi.fn();
    const sendStatusMessage = vi.fn();
    const freshContext = {};
    const send = new Function("sendTextReply", "telegramSessionContextStore", "menuActions",
      `return ({ ${callback} }).sendTargetText;`)(
      sendTextReply, { get: () => freshContext }, { sendStatusMessage },
    );
    await send({ chatId: 7, threadId: 42 }, "✅ New session started in this thread.");
    expect(sendStatusMessage).toHaveBeenCalledWith(7, 0, freshContext, 42);
    sendStatusMessage.mockClear();
    await send({ chatId: 7 }, "New session cancelled.");
    expect(sendStatusMessage).not.toHaveBeenCalled();
  });
});
