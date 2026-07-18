import { describe, expect, it, vi } from "vitest";

import {
  RESTART_EXIT_CODE,
  awaitShutdownDisposal,
  createShutdownLatch,
  restartExitCode,
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
});

describe("restartExitCode", () => {
  it("exits non-zero only for the restart reason so systemd restarts", () => {
    expect(restartExitCode("restart")).toBe(RESTART_EXIT_CODE);
    expect(RESTART_EXIT_CODE).not.toBe(0);
    expect(restartExitCode("extension")).toBe(0);
    expect(restartExitCode("SIGTERM")).toBe(0);
    expect(restartExitCode("SIGINT")).toBe(0);
  });
});

describe("awaitShutdownDisposal", () => {
  it("times out when graceful disposal never settles", async () => {
    vi.useFakeTimers();
    try {
      const disposal = awaitShutdownDisposal(
        () => new Promise<void>(() => {}),
        10_000,
      );

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(disposal).resolves.toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports graceful disposal before the timeout", async () => {
    await expect(
      awaitShutdownDisposal(async () => {}, 10_000),
    ).resolves.toBe("disposed");
  });
});
