import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrivateCdp } from "../../src/protected-browser.js";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Synthetic fixtures only. No protected action runs until endpoint readiness.
 * Capture stderr only during startup, before any test input is inserted. */
export async function waitForTestChrome(child: ChildProcess, profile: string, timeoutMs = 30_000) {
  let stderr = Buffer.alloc(0), accepting = true, terminal: Error | undefined;
  const capture = (chunk: Buffer) => { stderr = Buffer.concat([stderr, Buffer.from(chunk).subarray(-2_048)]).subarray(-2_048); };
  const failure = (reason: string) => new Error(`Test Chrome ${reason}; exit=${child.exitCode}; signal=${child.signalCode}; startup stderr: ${stderr.toString("utf8")}`);
  let rejectTerminal!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectTerminal = reject; });
  const fail = (reason: string) => { terminal ??= failure(reason); rejectTerminal(terminal); };
  const onExit = () => fail("exited before readiness");
  const onError = () => fail("spawn failed");
  child.stderr?.on("data", capture);
  child.on("exit", onExit); child.on("error", onError);
  const timer = setTimeout(() => fail("readiness timed out"), timeoutMs);
  try {
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    for (;;) {
      try {
        const contents = await Promise.race([readFile(join(profile, "DevToolsActivePort"), "utf8"), stopped]);
        const port = Number(contents.split("\n")[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          // A port file can precede HTTP/WebSocket readiness. Retry only this
          // connection, never a protected action. Close a late connection.
          const connection = PrivateCdp.connect(port).then(cdp => { if (!accepting) cdp.close(); return cdp; });
          const cdp = await Promise.race([connection, stopped]);
          return { port, cdp };
        }
      } catch {
        if (terminal) throw terminal;
      }
      await Promise.race([delay(50), stopped]);
    }
  } finally {
    accepting = false; clearTimeout(timer);
    child.stderr?.off("data", capture);
    child.off("exit", onExit); child.off("error", onError);
  }
}

/** Detached synthetic Chrome process group. Never signal unrelated browsers. */
export async function stopTestChrome(child: ChildProcess, graceMs = 2_000) {
  const running = () => child.exitCode === null && child.signalCode === null && !!child.pid;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!running()) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); child.off("exit", finish); resolve(); };
      const timer = setTimeout(finish, graceMs);
      child.once("exit", finish);
      try { process.kill(-child.pid!, signal); } catch { child.kill(signal); }
    });
  }
  if (running()) throw new Error("Test Chrome did not stop after SIGKILL");
}
