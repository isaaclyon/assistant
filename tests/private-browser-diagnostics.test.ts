import { describe, expect, it, vi } from "vitest";
import { privateBrowserReporter } from "../src/private-browser-diagnostics.js";

describe("host-only private browser diagnostics", () => {
  it("reports only a known error code, never content or arbitrary code strings", () => {
    const sink = vi.fn(), report = privateBrowserReporter("login", sink);
    report("observer-disconnect", Object.assign(new Error("synthetic-secret"), {
      code: "ENOENT", stdout: "synthetic-secret", stderr: "synthetic-secret", path: "/private/synthetic-secret",
    }));
    report("page-protect", { code: "synthetic-secret" });
    expect(sink.mock.calls).toEqual([
      [{ operation: "login", phase: "observer-disconnect", errorCode: "ENOENT" }],
      [{ operation: "login", phase: "page-protect" }],
    ]);
    expect(Object.isFrozen(sink.mock.calls[0]![0])).toBe(true);
  });
  it("does not evaluate an error getter or serialize an error", () => {
    const sink = vi.fn(), getter = vi.fn(() => { throw new Error("synthetic-secret"); });
    const error = Object.defineProperty({ toJSON: getter }, "code", { get: getter });
    privateBrowserReporter("input", sink)("page-protect", error);
    expect(getter).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ operation: "input", phase: "page-protect" });
  });
  it.each([-1, 256, 1.5, NaN, Infinity])("omits an invalid exit code %s", code => {
    const sink = vi.fn(); privateBrowserReporter("input", sink)("observer-disconnect", { code });
    expect(sink).toHaveBeenCalledExactlyOnceWith({ operation: "input", phase: "observer-disconnect" });
  });
  it("isolates synchronous, asynchronous and hostile-object diagnostic failures", async () => {
    const throwing = privateBrowserReporter("takeover", () => { throw new Error("sink unavailable"); });
    const rejecting = privateBrowserReporter("takeover", async () => { throw new Error("sink unavailable"); });
    expect(() => throwing("cleanup-page")).not.toThrow();
    rejecting("cleanup-page");
    const sink = vi.fn();
    expect(() => privateBrowserReporter("input", sink)("page-protect", new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error("synthetic-secret"); },
    }))).not.toThrow();
    await Promise.resolve(); // A rejected sink must not produce an unhandled rejection.
  });
});
