import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { startNativeJobsCoordinator } from "../../src/durable/coordinator.js";
import { openJobOccurrenceLedger } from "../../src/job-occurrences.js";

const NOW = Date.parse("2023-11-14T22:13:20.000Z");
let compiled: string;
beforeAll(async () => {
  const cache = join(process.cwd(), "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  compiled = await mkdtemp(join(cache, "coordinator-crash-"));
  await promisify(execFile)(process.execPath, ["node_modules/typescript/bin/tsc", "--strict", "--skipLibCheck",
    "--module", "nodenext", "--target", "es2024", "--rootDir", ".", "--outDir", compiled,
    "src/durable/coordinator.ts"], { timeout: 90_000 });
  // The compiled job-handoff imports a JS helper that tsc does not emit.
  await promisify(execFile)("cp", ["-R", join(process.cwd(), ".pi"), join(compiled, ".pi")]);
}, 100_000);
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });

test.each(["materialized", "published", "superseded", "cancelled"])("SIGKILL at %s recovers the same occurrence exactly once", async (phase) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-coordinator-crash-")));
  try {
    for (const dir of [root, "state", "state/instances", "state/instances/isaac", "state/instances/emma", "coordinator"]) {
      const path = join(root, dir);
      await mkdir(path, { recursive: true });
      await chmod(path, 0o700);
    }
    const child = fork(join(process.cwd(), "tests/durable/coordinator-crash-worker.mjs"), [compiled, root, phase],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", (chunk) => stderr += String(chunk));
    const paused = Promise.withResolvers<void>();
    child.on("message", (m: { type?: string }) => { if (m.type === "paused") paused.resolve(); });
    const exited = new Promise<string | null>((resolve) => child.once("exit", (code, signal) => {
      if (signal !== "SIGKILL") paused.reject(new Error(`Early worker exit ${code}: ${stderr}`));
      resolve(signal);
    }));
    const timer = setTimeout(() => paused.reject(new Error(`Worker IPC timeout: ${stderr}`)), 15_000);
    try { await paused.promise; } catch (error) { child.kill("SIGKILL"); throw error; } finally { clearTimeout(timer); }
    child.kill("SIGKILL");
    expect(await exited).toBe("SIGKILL");
    expect(await readFile(join(root, "barriers"), "utf8")).toBe(`${phase}\n`);

    const emma = join(root, "state/instances/emma/job-handoffs");
    const files = async (state: string) => readdir(join(emma, state)).catch(() => [] as string[]);
    if (phase === "materialized") expect(await files("pending")).toEqual([]);
    if (phase === "published") expect(await files("pending")).toHaveLength(1);
    const ledgerBefore = openJobOccurrenceLedger(join(root, "coordinator"));
    expect(ledgerBefore.pending().length + ledgerBefore.superseded().length).toBe(1);
    ledgerBefore.close();

    const restarted = await startNativeJobsCoordinator({
      instanceId: "isaac", stateDir: join(root, "state/instances/isaac"),
      coordinator: { stateRoot: join(root, "state"), coordinatorStateDir: join(root, "coordinator"), targets: ["isaac", "emma"], scope: "shared-owner" },
    }, { logger: { info() {}, warn() {}, error() {} }, nowMs: () => NOW + 60_000 });
    try {
      await restarted.tick();
      await restarted.tick();
      if (phase === "superseded" || phase === "cancelled") {
        expect(await files("pending")).toEqual([]);
        expect(await files("cancelled")).toHaveLength(1);
      } else {
        const [name] = await files("pending");
        expect(await files("pending")).toHaveLength(1);
        expect(JSON.parse(await readFile(join(emma, "pending", name!), "utf8")).createdAt).toBe(new Date(NOW).toISOString());
        const ledger = openJobOccurrenceLedger(join(root, "coordinator"));
        await vi.waitFor(() => expect(ledger.pending()).toEqual([]));
        ledger.close();
      }
    } finally { await restarted.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
