import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

const queue = await import(pathToFileURL(join(dirname(resolveTelegramExtensionPath()), "lib/queue.ts")).href);

describe("proactive silent veto", () => {
  async function deliver(text: string, human = false) {
    const send = vi.fn();
    const reset = vi.fn();
    const dispatch = vi.fn();
    await queue.handleTelegramAgentEndRuntime({
      turn: human ? { chatId: 7, replyToMessageId: 1, queuedAttachments: [] } : undefined,
      assistant: { text, stopReason: "stop" },
      foldQueuedPromptsIntoHistory: false,
      resetRuntimeState: reset, updateStatus: vi.fn(),
      dispatchNextQueuedTelegramTurn: dispatch,
      clearPreview: vi.fn(), setPreviewPendingText: vi.fn(),
      finalizeMarkdownPreview: vi.fn().mockResolvedValue(false),
      sendMarkdownReply: send, sendTextReply: vi.fn(), sendQueuedAttachments: vi.fn(),
      isProactivePushEnabled: () => true, canSendProactivePush: () => true,
      getDefaultChatId: () => 7,
    });
    expect(reset).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    return send;
  }

  it("suppresses an exact proactive veto while completing queue cleanup", async () => {
    expect(await deliver("  NO_REPLY\n")).not.toHaveBeenCalled();
  });
  it("delivers positive alerts and text mentioning the marker", async () => {
    expect(await deliver("The service is down; please investigate.")).toHaveBeenCalledOnce();
    expect(await deliver("The email contains NO_REPLY.")).toHaveBeenCalledOnce();
  });
  it("preserves a human-requested literal marker", async () => {
    expect(await deliver("NO_REPLY", true)).toHaveBeenCalledOnce();
  });
});
