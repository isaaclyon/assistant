import { describe, expect, it, vi } from "vitest";

import { createShutdownLatch } from "../src/lifecycle.js";

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
});
