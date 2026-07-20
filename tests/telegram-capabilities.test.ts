import { describe, expect, it, vi } from "vitest";

import {
  bindBridgeRestart,
  bindBridgeRuntimeMarker,
} from "../src/telegram-capabilities.js";

const RESTART_REGISTRY = Symbol.for("pi-telegram-bridge.restart-registry");
const RUNTIME_REGISTRY = Symbol.for("pi-telegram-bridge.runtime-registry");

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
