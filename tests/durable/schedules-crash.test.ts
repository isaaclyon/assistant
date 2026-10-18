import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { startNativeJobsCoordinator } from "../../src/durable/coordinator.js";
import type { NativeScheduleConfig, NativeScheduleTestOptions } from "../../src/durable/schedules.js";
import { openJobOccurrenceLedger } from "../../src/job-occurrences.js";

const HOUR = 3_600_000;
const START = Date.parse("2026-07-18T10:00:00.000Z");
let compiled: string;
beforeAll(async () => {
  const cache = join(process.cwd(), "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  compiled = await mkdtemp(join(cache, "schedules-crash-"));
  await promisify(execFile)(process.execPath, ["node_modules/typescript/bin/tsc", "--strict", "--skipLibCheck",
    "--module", "nodenext", "--target", "es2024", "--rootDir", ".", "--outDir", compiled,
    "src/durable/coordinator.ts"], { timeout: 90_000 });
  await promisify(execFile)("cp", ["-R", join(process.cwd(), ".pi"), join(compiled, ".pi")]);
}, 100_000);
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });

const silent = { info() {}, warn() {}, error() {} };
async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-schedules-crash-")));
  for (const dir of [root, "state", "state/instances", "state/instances/isaac", "state/instances/emma", "coordinator"]) {
    const path = join(root, dir);
    await mkdir(path, { recursive: true });
    await chmod(path, 0o700);
  }
  return root;
}

/** Runs the worker until its barrier, optionally drives it, then SIGKILLs it. */
async function runAndKill(root: string, kind: string, phase: string, drive?: (port: number) => Promise<void>) {
  const child = fork(join(process.cwd(), "tests/durable/schedules-crash-worker.mjs"), [compiled, root, kind, phase],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    let stderr = "";
    child.stderr!.on("data", (chunk) => stderr += String(chunk));
    const paused = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<number>();
    void ready.promise.catch(() => {});
    child.on("message", (m: { type?: string; port?: number }) => {
      if (m.type === "paused") paused.resolve();
      if (m.type === "ready") ready.resolve(m.port!);
    });
    const exited = new Promise<string | null>((resolve) => child.once("exit", (code, signal) => {
      if (signal !== "SIGKILL") {
        const error = new Error(`Early worker exit ${code}: ${stderr}`);
        paused.reject(error); ready.reject(error);
      }
      resolve(signal);
    }));
    const timer = setTimeout(() => {
      const error = new Error(`Worker IPC timeout: ${stderr}`);
      paused.reject(error); ready.reject(error);
    }, 20_000);
    try {
      if (drive) await drive(await ready.promise);
      await paused.promise;
    } finally { clearTimeout(timer); }
    child.kill("SIGKILL");
    expect(await exited).toBe("SIGKILL");
    expect(await readFile(join(root, "barriers"), "utf8")).toBe(`${kind}:${phase}\n`);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}

const instances = (root: string) => ({
  handoffs: (state = "pending") => readdir(join(root, "state/instances/emma/job-handoffs", state)).catch(() => [] as string[]),
});
const pendingIds = (root: string) => {
  const ledger = openJobOccurrenceLedger(join(root, "coordinator"));
  try { return ledger.pending().map((o) => o.id); } finally { ledger.close(); }
};
async function restart(root: string, schedules: NativeScheduleConfig, seams: NativeScheduleTestOptions, nowMs: () => number) {
  return startNativeJobsCoordinator({
    instanceId: "isaac", stateDir: join(root, "state/instances/isaac"),
    coordinator: { stateRoot: join(root, "state"), coordinatorStateDir: join(root, "coordinator"),
      targets: ["isaac", "emma"], scope: "shared-owner", schedules },
    google: { account: "synthetic@example.test", gog: { binary: "/opt/gog", passwordFile: "/secrets/gog", home: "/gog-home" } },
  }, { logger: silent, nowMs, schedules: seams });
}

test.each(["materialized", "published"])("SIGKILL at heartbeat %s keeps the cursor and one pending occurrence without re-reading", async (phase) => {
  const root = await layout();
  try {
    await runAndKill(root, "heartbeat", phase);
    const { handoffs } = instances(root);
    expect(await handoffs()).toHaveLength(phase === "published" ? 1 : 0);

    const state = JSON.parse(await readFile(join(root, "coordinator/checkers/inbox.json"), "utf8"));
    expect(state.lastObservation.cursor).toEqual({ since: 2 });
    expect(state.pendingEvent.matches[0].item.id).toBe("a");
    const original = pendingIds(root);
    expect(original).toHaveLength(1);

    const clock = { ms: START + 3 * HOUR };
    const runCheck = vi.fn().mockRejectedValue(new Error("restart must not re-read"));
    const judge = vi.fn().mockRejectedValue(new Error("restart must not re-judge"));
    const restarted = await restart(root, { checkerIds: ["gmail-inbox"] }, { runCheck, judge }, () => clock.ms);
    try {
      clock.ms += HOUR;
      await restarted.tick();
      await restarted.tick();
      expect(runCheck).not.toHaveBeenCalled();
      expect(judge).not.toHaveBeenCalled();
      expect(await handoffs()).toHaveLength(1);
      expect(pendingIds(root)).toEqual([]);
      const [name] = await handoffs();
      const handoff = JSON.parse(await readFile(join(root, "state/instances/emma/job-handoffs/pending", name!), "utf8"));
      expect(handoff).toMatchObject({ dispatchId: original[0], createdAt: new Date(START + 2 * HOUR).toISOString() });
      const after = JSON.parse(await readFile(join(root, "coordinator/checkers/inbox.json"), "utf8"));
      expect(after.pendingEvent ?? null).toBeNull();
      expect(after.lastObservation.cursor).toEqual({ since: 2 });
    } finally { await restarted.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

test.each(["materialized", "published"])("SIGKILL at webhook %s after the 202 recovers the same occurrence once", async (phase) => {
  const root = await layout();
  try {
    let status = 0;
    await runAndKill(root, "webhook", phase, async (port) => {
      const secret = (await readFile(join(root, "coordinator/webhook-secret"), "utf8")).trim();
      const response = await fetch(`http://127.0.0.1:${port}/hook/hook`, {
        method: "POST", body: JSON.stringify({ synthetic: true }), headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
    });
    expect(status).toBe(202);
    const { handoffs } = instances(root);
    expect(await handoffs()).toHaveLength(phase === "published" ? 1 : 0);
    const original = pendingIds(root);
    expect(original).toHaveLength(1);

    const restarted = await restart(root, { checkerIds: [], webhook: { port: 8123 } }, { webhookPort: 0 }, () => START + HOUR);
    try {
      await restarted.tick();
      await restarted.tick();
      expect(await handoffs()).toHaveLength(1);
      expect(pendingIds(root)).toEqual([]);
      const [name] = await handoffs();
      const handoff = JSON.parse(await readFile(join(root, "state/instances/emma/job-handoffs/pending", name!), "utf8"));
      expect(handoff).toMatchObject({ dispatchId: original[0], createdAt: new Date(START).toISOString() });
      expect(handoff.prompt).toContain("Handle it");
    } finally { await restarted.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
