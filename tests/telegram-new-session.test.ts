import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveTelegramExtensionPath } from "../src/package-paths.js";

describe("Telegram /new delivery", () => {
  it("ignores a redelivery of the same Telegram message after replacement", async () => {
    const commands = await import(
      pathToFileURL(
        join(dirname(resolveTelegramExtensionPath()), "lib", "commands.ts"),
      ).href
    );
    const message = {
      chat: { id: 7 },
      message_id: 930_001,
      message_thread_id: 42,
    };
    const replies: string[] = [];
    let requests = 0;
    const createRuntime = () =>
      commands.createTelegramCommandOrPromptRuntime({
        extractRawText: (messages: typeof message[]) =>
          messages[0] ? "/new" : "",
        handleCommand: async (
          command: string | undefined,
          nextMessage: typeof message,
        ) => {
          if (command !== "new") return false;
          await commands.handleTelegramNewSessionCommand(nextMessage, {
            isIdle: () => true,
            hasPendingMessages: () => false,
            hasActiveTelegramTurn: () => false,
            hasDispatchPending: () => false,
            hasQueuedTelegramItems: () => false,
            isCompactionInProgress: () => false,
            hasPendingSessionReplacement: () => false,
            requestNewSession: () => {
              requests += 1;
              return { accepted: true };
            },
            getMessageTarget: (currentMessage: typeof message) => ({
              chatId: currentMessage.chat.id,
              threadId: currentMessage.message_thread_id,
            }),
            sendTextReply: async (text: string) => {
              replies.push(text);
            },
          });
          return true;
        },
        enqueueTurn: async () => {
          throw new Error("/new should be consumed");
        },
        replaceMessageText: (currentMessage: typeof message) => currentMessage,
      });

    await createRuntime().dispatchMessages([message], {});
    // Session replacement creates a new command runtime; dedup must survive it.
    await createRuntime().dispatchMessages([message], {});

    expect(requests).toBe(1);
    expect(replies).toEqual(["🆕 Starting a new session in this thread."]);
  });

  it("ignores a redelivered household confirmation message", async () => {
    const commands = await import(
      pathToFileURL(
        join(dirname(resolveTelegramExtensionPath()), "lib", "commands.ts"),
      ).href
    );
    const message = {
      chat: { id: -1007 },
      message_id: 930_002,
      message_thread_id: 9,
    };
    const confirmations: Array<{ chatId: number; threadId?: number }> = [];
    const deps = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      hasActiveTelegramTurn: () => false,
      hasDispatchPending: () => false,
      hasQueuedTelegramItems: () => false,
      isCompactionInProgress: () => false,
      hasPendingSessionReplacement: () => false,
      requestNewSession: () => ({ accepted: true }),
      getMessageTarget: (currentMessage: typeof message) => ({
        chatId: currentMessage.chat.id,
        threadId: currentMessage.message_thread_id,
      }),
      sendTextReply: async () => undefined,
      requiresConfirmation: () => true,
      sendConfirmation: async (target: {
        chatId: number;
        threadId?: number;
      }) => {
        confirmations.push(target);
      },
    };

    await commands.handleTelegramNewSessionCommand(message, deps);
    await commands.handleTelegramNewSessionCommand(message, deps);

    expect(confirmations).toEqual([{ chatId: -1007, threadId: 9 }]);
  });
});
