import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  resolveRetryExtensionPath,
  resolveTelegramExtensionPath,
} from "../src/package-paths.js";

describe("pinned retry extension", () => {
  it("classifies Codex websocket limits for Pi's built-in retry", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const mod = (await import(pathToFileURL(resolveRetryExtensionPath()).href)) as {
      default: (pi: unknown, options: unknown) => void;
    };
    mod.default(
      {
        registerFlag: vi.fn(),
        getFlag: vi.fn(),
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers.set(event, handler);
        },
      },
      { readRetryPolicy: () => ({ enabled: true, errors: [] }) },
    );

    const messageEnd = handlers.get("message_end");
    const result = (await messageEnd?.(
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "websocket_connection_limit_reached",
        },
      },
      {
        hasUI: false,
        ui: { setStatus: vi.fn() },
      },
    )) as { message: { errorMessage: string } };

    expect(result.message.errorMessage).toContain("provider returned error");
  });

  it("keeps the Telegram turn until Pi finishes retrying", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const lifecyclePath = join(
      dirname(resolveTelegramExtensionPath()),
      "lib",
      "lifecycle.ts",
    );
    const { registerTelegramLifecycleHooks } = (await import(
      pathToFileURL(lifecyclePath).href
    )) as {
      registerTelegramLifecycleHooks: (pi: unknown, deps: unknown) => void;
    };
    const delivered: string[] = [];
    registerTelegramLifecycleHooks(
      {
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers.set(event, handler);
        },
      },
      {
        onSessionStart: vi.fn(),
        onSessionShutdown: vi.fn(),
        onBeforeAgentStart: vi.fn(),
        onModelSelect: vi.fn(),
        onAgentStart: vi.fn(),
        onToolExecutionStart: vi.fn(),
        onToolExecutionEnd: vi.fn(),
        onMessageStart: vi.fn(),
        onMessageUpdate: vi.fn(),
        onAgentEnd: (event: { messages: Array<{ text: string }> }) => {
          delivered.push(event.messages.at(-1)?.text ?? "");
        },
      },
    );

    await handlers.get("agent_end")?.(
      { messages: [{ text: "retryable websocket error" }] },
      {},
    );
    expect(delivered).toEqual([]);

    await handlers.get("agent_end")?.({ messages: [{ text: "final answer" }] }, {});
    await handlers.get("agent_settled")?.({}, {});
    expect(delivered).toEqual(["final answer"]);
  });
});
