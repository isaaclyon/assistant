import { describe, expect, it, vi } from "vitest";

import {
  createShutdownLatch,
  waitForShutdown,
} from "../src/lifecycle.js";

describe("shutdown lifecycle", () => {
  it("resolves once and preserves the first shutdown reason", async () => {
    const onRequested = vi.fn();
    const latch = createShutdownLatch(onRequested);

    latch.request("SIGTERM");
    latch.request("SIGINT");

    await expect(latch.wait()).resolves.toBe("SIGTERM");
    expect(onRequested).toHaveBeenCalledTimes(1);
    expect(onRequested).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps a headless process alive until shutdown is requested", async () => {
    const latch = createShutdownLatch();
    const clearKeepAlive = vi.fn();
    const keepAlive = Symbol("keep-alive");
    const startKeepAlive = vi.fn(() => keepAlive);

    const waiting = waitForShutdown(latch, {
      start: startKeepAlive,
      clear: clearKeepAlive,
    });
    latch.request("test");

    await expect(waiting).resolves.toBe("test");
    expect(startKeepAlive).toHaveBeenCalledOnce();
    expect(clearKeepAlive).toHaveBeenCalledWith(keepAlive);
  });
});
