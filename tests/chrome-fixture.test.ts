import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ readFile: vi.fn(), connect: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: h.readFile }));
vi.mock("../src/protected-browser.js", () => ({ PrivateCdp: { connect: h.connect } }));
import { stopTestChrome, waitForTestChrome } from "./fixtures/chrome.js";

type MutableChild = { -readonly [Key in keyof ChildProcess]: ChildProcess[Key] };
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 123456, exitCode: null as number | null, signalCode: null as string | null,
    stderr: new PassThrough(), kill: vi.fn(),
  }) as unknown as MutableChild;
}
beforeEach(() => {
  vi.useFakeTimers(); h.readFile.mockReset(); h.connect.mockReset();
  h.readFile.mockResolvedValue("12345\n/devtools/browser/synthetic\n");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("waits through a partial port file and a refused endpoint before returning a connected browser", async () => {
  const cdp = { close: vi.fn() };
  h.readFile.mockResolvedValueOnce("").mockResolvedValueOnce("0\n");
  h.connect.mockRejectedValueOnce(new Error("endpoint starting")).mockResolvedValue(cdp);
  const ready = waitForTestChrome(child(), "/synthetic/profile", 500);
  const assertion = expect(ready).resolves.toEqual({ port: 12345, cdp });
  await vi.advanceTimersByTimeAsync(200);
  await assertion;
  expect(h.connect).toHaveBeenCalledTimes(2);
  expect(h.connect).toHaveBeenCalledWith(12345);
});

it("reports early Chrome exit with bounded startup stderr", async () => {
  const chrome = child();
  h.readFile.mockRejectedValue(new Error("not yet"));
  const ready = waitForTestChrome(chrome, "/synthetic/profile", 500);
  const assertion = expect(ready).rejects.toThrow(/exit=7.*synthetic startup failure/s);
  chrome.stderr!.emit("data", Buffer.from("x".repeat(5_000) + "synthetic startup failure"));
  chrome.exitCode = 7; chrome.emit("exit", 7, null);
  await vi.advanceTimersByTimeAsync(50);
  await assertion;
  expect(chrome.stderr!.listenerCount("data")).toBe(0);
});

it("handles spawn failure without an unhandled error event", async () => {
  const chrome = child();
  h.readFile.mockRejectedValue(new Error("not yet"));
  const ready = waitForTestChrome(chrome, "/synthetic/profile", 500);
  const assertion = expect(ready).rejects.toThrow(/spawn/);
  chrome.emit("error", new Error("synthetic spawn failure"));
  await vi.advanceTimersByTimeAsync(50);
  await assertion;
});

it("bounds a stuck readiness connection and closes a connection that arrives after the deadline", async () => {
  let finish!: (cdp: { close: ReturnType<typeof vi.fn> }) => void;
  h.connect.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const chrome = child(), ready = waitForTestChrome(chrome, "/synthetic/profile", 100);
  const assertion = expect(ready).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  const cdp = { close: vi.fn() }; finish(cdp);
  await vi.advanceTimersByTimeAsync(0);
  expect(cdp.close).toHaveBeenCalledOnce();
  expect(chrome.stderr!.listenerCount("data")).toBe(0);
});

it("detaches startup listeners once ready", async () => {
  const chrome = child(), cdp = { close: vi.fn() };
  h.connect.mockResolvedValue(cdp);
  await expect(waitForTestChrome(chrome, "/synthetic/profile", 100)).resolves.toEqual({ port: 12345, cdp });
  expect(chrome.stderr!.listenerCount("data")).toBe(0);
  expect(chrome.listenerCount("error")).toBe(0);
});

it("escalates to SIGKILL if Chrome ignores SIGTERM and releases the exit listener", async () => {
  const chrome = child();
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGKILL") { chrome.signalCode = "SIGKILL"; chrome.emit("exit", null, "SIGKILL"); }
    return true;
  });
  const stopped = stopTestChrome(chrome, 100);
  await vi.advanceTimersByTimeAsync(100);
  await stopped;
  expect(kill.mock.calls.map(call => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
  expect(chrome.listenerCount("exit")).toBe(0);
});

it("fails within the cleanup limit if Chrome never exits", async () => {
  const chrome = child(); vi.spyOn(process, "kill").mockReturnValue(true);
  const assertion = expect(stopTestChrome(chrome, 100)).rejects.toThrow(/did not stop/);
  await vi.advanceTimersByTimeAsync(200);
  await assertion;
  expect(chrome.listenerCount("exit")).toBe(0);
});

it("allows a cold startup beyond the former 15-second port-file limit", async () => {
  h.readFile.mockImplementation(async () => {
    if (Date.now() < 16_000) throw new Error("cold startup");
    return "12345\n";
  });
  vi.setSystemTime(0);
  const cdp = { close: vi.fn() }; h.connect.mockResolvedValue(cdp);
  const ready = waitForTestChrome(child(), "/synthetic/profile");
  await vi.advanceTimersByTimeAsync(16_000);
  await expect(ready).resolves.toEqual({ port: 12345, cdp });
});

it("does not escalate a normal exit or signal an already exited browser", async () => {
  const chrome = child();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    chrome.signalCode = "SIGTERM"; chrome.emit("exit", null, "SIGTERM"); return true;
  });
  await stopTestChrome(chrome, 100);
  await stopTestChrome(chrome, 100);
  expect(kill).toHaveBeenCalledExactlyOnceWith(-chrome.pid!, "SIGTERM");
  expect(chrome.listenerCount("exit")).toBe(0);
});
