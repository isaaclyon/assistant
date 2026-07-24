import { describe, expect, it, vi } from "vitest";

import {
  bindBridgeRestart,
  bindBridgeRuntimeMarker,
  bindTelegramHostHouseholdGroup,
  bindTelegramHostNewSession,
  bindTelegramHostPromptPreparation,
  getTelegramSessionReplacementBlockingReason,
} from "../src/telegram-capabilities.js";

const RESTART_REGISTRY = Symbol.for("pi-telegram-bridge.restart-registry");
const RUNTIME_REGISTRY = Symbol.for("pi-telegram-bridge.runtime-registry");
const HOST_REGISTRY = Symbol.for("pi-telegram.host-capability-registry");

function readRegistry(): { request?: unknown } | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[RESTART_REGISTRY];
  return value && typeof value === "object"
    ? (value as { request?: unknown })
    : undefined;
}

describe("bindBridgeRestart", () => {
  it("publishes an invokable request that the /restart extension reads by symbol", () => {
    const request = vi.fn();
    const unbind = bindBridgeRestart(request);

    const bound = readRegistry()?.request;
    expect(typeof bound).toBe("function");
    (bound as () => void)();
    expect(request).toHaveBeenCalledTimes(1);

    unbind();
    expect(readRegistry()?.request).toBeUndefined();
  });

  it("rejects a second binding until the first unbinds", () => {
    const unbind = bindBridgeRestart(vi.fn());
    expect(() => bindBridgeRestart(vi.fn())).toThrow(/already registered/);
    unbind();
    // Rebinding after unbind must succeed, then clean up for other tests.
    bindBridgeRestart(vi.fn())();
  });

  it("reads the fork-owned replacement guard without exposing runtime state", () => {
    const unbind = bindTelegramHostNewSession(async () => ({ cancelled: false }));
    const registry = (globalThis as Record<PropertyKey, unknown>)[
      HOST_REGISTRY
    ] as Record<string, unknown>;
    registry.replacementGuard = ({ trigger }: { trigger: string }) =>
      trigger.startsWith("job:") ? "Telegram work is queued." : undefined;
    registry.replacementGuardToken = {};
    expect(getTelegramSessionReplacementBlockingReason("job:cron")).toBe(
      "Telegram work is queued.",
    );
    expect(getTelegramSessionReplacementBlockingReason("telegram")).toBeUndefined();
    delete registry.replacementGuard;
    delete registry.replacementGuardToken;
    unbind();
  });
});

describe("bindBridgeRuntimeMarker", () => {
  it("marks only the lifetime of the bridge host runtime", () => {
    const unbind = bindBridgeRuntimeMarker();
    const registry = (globalThis as Record<PropertyKey, unknown>)[RUNTIME_REGISTRY];

    expect(registry).toMatchObject({ version: 1, runtime: {} });
    unbind();
    expect(registry).toEqual({ version: 1 });
  });
});

describe("Telegram host capability bindings", () => {
  it("binds session replacement, prompt preparation, and household policy independently", () => {
    const unbindSession = bindTelegramHostNewSession(async () => ({
      cancelled: false,
    }));
    const unbindHousehold = bindTelegramHostHouseholdGroup({
      kind: "household-group",
      chatId: -100123,
      actors: [
        { userId: 101, label: "Isaac" },
        { userId: 202, label: "Emma" },
      ],
    });
    const unbindPreparation = bindTelegramHostPromptPreparation(async () => ({
      sessionReplaced: false,
    }));
    const registry = (globalThis as Record<PropertyKey, unknown>)[
      HOST_REGISTRY
    ];
    expect(registry).toMatchObject({
      version: 1,
      provider: expect.any(Function),
      token: expect.any(Object),
      householdGroup: {
        kind: "household-group",
        chatId: -100123,
        actors: [
          { userId: 101, label: "Isaac" },
          { userId: 202, label: "Emma" },
        ],
      },
      householdToken: expect.any(Object),
      promptPreparation: expect.any(Function),
      promptPreparationToken: expect.any(Object),
    });

    unbindHousehold();
    expect(registry).toMatchObject({
      version: 1,
      provider: expect.any(Function),
      token: expect.any(Object),
    });
    expect(registry).not.toHaveProperty("householdGroup");
    unbindPreparation();
    expect(registry).not.toHaveProperty("promptPreparation");
    unbindSession();
    expect(registry).toEqual({ version: 1 });
  });
});
