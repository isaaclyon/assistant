import { describe, expect, it } from "vitest";

import {
  bindTargetScope,
  getOverrideTarget,
} from "../node_modules/@llblab/pi-telegram/lib/bridge-target-scope.js";

describe("Telegram subagent completion target scope", () => {
  it("captures the active launch target and scopes proactive delivery", async () => {
    bindTargetScope(() => ({ chatId: -1007, threadId: 42 }));
    const registry = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("pi-telegram-bridge.target-scope-registry")
    ] as { provider: { getActiveTarget(): unknown; withTarget(target: { chatId: number; threadId?: number }, work: () => Promise<void>): Promise<void> } };
    expect(registry.provider.getActiveTarget()).toEqual({ chatId: -1007, threadId: 42 });
    await registry.provider.withTarget({ chatId: 8, threadId: 9 }, async () => {
      expect(getOverrideTarget()).toEqual({ chatId: 8, threadId: 9 });
    });
    expect(getOverrideTarget()).toBeUndefined();
  });
});
