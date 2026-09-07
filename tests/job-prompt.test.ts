import { describe, expect, it, vi } from "vitest";
import { injectJobPrompt } from "../src/job-prompt.js";

describe("Pi job prompt acceptance boundary", () => {
  it("cancels a shutdown-blocked preparation without invoking Pi afterward", async () => {
    const controller = new AbortController();
    const prompt = vi.fn();
    const preflight = vi.fn();
    const prepare = vi.fn(() => new Promise<void>(() => {}));
    const pending = injectJobPrompt({
      waitForIdle: async () => {}, prepare, prompt,
    }, "synthetic", preflight, controller.signal);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("cancels a shutdown-blocked idle wait before invoking Pi", async () => {
    const controller = new AbortController();
    const prompt = vi.fn();
    const preflight = vi.fn();
    const pending = injectJobPrompt({
      waitForIdle: () => new Promise<void>(() => {}), prepare: async () => {}, prompt,
    }, "synthetic", preflight, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("reports preparation failure as known-unaccepted without invoking Pi", async () => {
    const preflight = vi.fn();
    const prompt = vi.fn();
    await expect(injectJobPrompt({
      waitForIdle: async () => {},
      prepare: async () => { throw new Error("rotation failed"); },
      prompt,
    }, "synthetic", preflight)).rejects.toThrow("rotation failed");
    expect(preflight).toHaveBeenCalledWith(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])("never retries an exception with preflight=%s", async (accepted) => {
    const preflight = vi.fn();
    const prompt = vi.fn(async (_text: string, options: { preflightResult: (accepted: boolean) => void }) => {
      if (accepted !== undefined) options.preflightResult(accepted);
      throw new Error("already processing");
    });
    await expect(injectJobPrompt({
      waitForIdle: async () => {}, prepare: async () => {}, prompt,
    }, "synthetic", preflight)).rejects.toThrow("already processing");
    expect(prompt).toHaveBeenCalledTimes(1);
    if (accepted === undefined) expect(preflight).not.toHaveBeenCalled();
    else expect(preflight).toHaveBeenCalledExactlyOnceWith(accepted);
  });
});
