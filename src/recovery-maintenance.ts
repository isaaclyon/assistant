import { execFile } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";
import { initializeLegacyJobLedger, readMigrationJson } from "./jobs-migration.js";
import { loadValidatedJobs } from "./jobs-validation.js";
import { openJobOccurrenceLedger } from "./job-occurrences.js";
import { resolveBridgeConfig } from "./config.js";
import { captureRecoverySnapshot, markRecoveryStarted, restoreRecoverySnapshot } from "./recovery-snapshot.js";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertQuiescent(unitDir: string): Promise<void> {
  const run = async (...args: string[]): Promise<string> => (await promisify(execFile)("systemctl", ["--user", ...args],
    { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const names = new Set<string>();
  for (const args of [["list-unit-files", "--no-legend"], ["list-units", "--all", "--no-legend", "--plain"]]) {
    for (const line of (await run(...args, "pi-telegram-bridge*.service")).split("\n").filter(Boolean)) {
      const name = line.trim().split(/\s+/)[0]!;
      if (!/^pi-telegram-bridge(?:-[a-z0-9-]{1,64})?\.service$/.test(name)) throw new Error("Unknown bridge service");
      names.add(name);
    }
  }
  for (const name of names) {
    const state = await run("show", name, "--property", "ActiveState", "--value");
    const pid = await run("show", name, "--property", "MainPID", "--value");
    const enabled = await run("show", name, "--property", "UnitFileState", "--value");
    if (!["inactive", "failed"].includes(state) || pid !== "0" || !["disabled", "masked", "not-found"].includes(enabled)) {
      throw new Error("Bridge units must be stopped and disabled for recovery maintenance");
    }
    if (await run("show", name, "--property", "FragmentPath", "--value") !== join(unitDir, name) ||
        await run("show", name, "--property", "DropInPaths", "--value") !== "") {
      throw new Error("Bridge unit is outside the captured unit directory or has unreviewed drop-in overrides");
    }
  }
}

export async function runRecoveryMaintenance(args: string[]): Promise<void> {
const [action, snapshotArg, stateArg, unitArg, releaseArg, coordinatorId, ...configuredIds] = args;
if (!snapshotArg) throw new Error("Recovery maintenance requires an action and private snapshot path");
const snapshotDir = resolve(snapshotArg);
  let expectedUnitDir: string;
  if (action === "prepare" && unitArg) expectedUnitDir = resolve(unitArg);
  else if (action === "started" || action === "restore") {
    const { value } = await readMigrationJson(join(snapshotDir, "snapshot.json"));
    if (!value || typeof value !== "object" || !("unitDir" in value) || typeof value.unitDir !== "string") throw new Error("Invalid snapshot unit directory");
    expectedUnitDir = value.unitDir;
  } else throw new Error("Invalid recovery maintenance arguments");
  await assertQuiescent(expectedUnitDir);
  if (action === "started") {
    await markRecoveryStarted(snapshotDir);
  } else if (action === "restore") {
    // The runbook requires all services stopped and external writers paused.
    await restoreRecoverySnapshot(snapshotDir);
    process.stdout.write("Paired pre-start state and binaries restored; services remain stopped.\n");
  } else if (action === "prepare" && stateArg && unitArg && releaseArg && coordinatorId) {
    const stateRoot = resolve(stateArg); const unitDir = resolve(unitArg); const releaseRoot = resolve(releaseArg);
    const singleton = coordinatorId === "local" && configuredIds.length === 0;
    if (!/^[a-z0-9-]{1,64}$/.test(coordinatorId) || configuredIds.some((id) => !/^[a-z0-9-]{1,64}$/.test(id))) {
      throw new Error("Invalid recovery instance identity");
    }
    const roots: Record<string, string> = {};
    if (singleton) {
      if (resolveBridgeConfig().stateDir !== stateRoot) throw new Error("Singleton state root differs from its environment configuration");
      if (await exists(join(stateRoot, "instances")) && (await readdir(join(stateRoot, "instances"))).length) {
        throw new Error("Fleet state requires explicit reconciliation before singleton migration");
      }
      roots.local = stateRoot;
    }
    else {
      // Retired and unexpected recipient roots must not disappear from inventory.
      const instances = join(stateRoot, "instances");
      for (const id of await readdir(instances)) {
        if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error("Unknown instance state blocks recovery migration");
        roots[id] = join(instances, id);
      }
      for (const id of configuredIds) if (!Object.hasOwn(roots, id)) throw new Error("Missing configured instance state");
      for (const name of ["jobs.json", "jobs-state.json", "job-handoffs", "job-dispatches", "job-occurrences.db"]) {
        if (await exists(join(stateRoot, name))) throw new Error("Singleton recovery state requires explicit reconciliation before fleet migration");
      }
    }
    const coordinatorStateDir = roots[coordinatorId];
    if (!coordinatorStateDir || (!singleton && !configuredIds.includes(coordinatorId))) throw new Error("Missing recovery coordinator state");
    const lockPaths: string[] = [];
    for (const [id, root] of Object.entries(roots).sort()) {
      const info = await lstat(root);
      if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) throw new Error("Unsafe instance recovery directory");
      if (id !== coordinatorId && await exists(join(root, "job-dispatches")) && (await readdir(join(root, "job-dispatches"))).length) {
        throw new Error("Additional coordinator evidence requires explicit reconciliation");
      }
      if (id !== coordinatorId) {
        for (const name of ["jobs.json", "jobs-state.json", "job-occurrences.db"]) {
          if (await exists(join(root, name))) throw new Error("Additional coordinator state requires explicit reconciliation");
        }
      }
      lockPaths.push(join(root, ".jobs-mutation-lock.sqlite"));
      const handoffs = join(root, "job-handoffs");
      if (await exists(handoffs)) {
        lockPaths.push(join(handoffs, ".drain-lock.sqlite"), join(handoffs, ".transition-lock.sqlite"));
      }
    }
    async function locked(index: number): Promise<void> {
      if (index < lockPaths.length) return withMutationLock(lockPaths[index]!, () => locked(index + 1), { timeoutMs: 0 });
      await captureRecoverySnapshot({ stateRoot, unitDir, releaseRoot, snapshotDir });
      // Validate exact source JSON before the normal scheduler parser sees it.
      const jobsPath = join(coordinatorStateDir!, "jobs.json");
      if (await exists(jobsPath)) await readMigrationJson(jobsPath);
      const { jobs } = await loadValidatedJobs({ stateDir: coordinatorStateDir!,
        ...(singleton ? {} : { configuredInstanceIds: configuredIds }) });
      if (await exists(join(coordinatorStateDir!, "job-occurrences.db"))) {
        const ledger = openJobOccurrenceLedger(coordinatorStateDir!); ledger.close();
        process.stdout.write("Recovery snapshot verified; occurrence ledger already initialized.\n");
      } else {
        const report = await initializeLegacyJobLedger({ coordinatorStateDir: coordinatorStateDir!, recipients: roots, jobs });
        process.stdout.write(JSON.stringify({ dispatches: report.dispatches, recipientFiles: report.recipientFiles,
          suppressedOneShots: report.suppressAt.length, digest: report.digest }) + "\n");
      }
    }
    await mkdir(unitDir, { recursive: true, mode: 0o700 });
    await locked(0);
  } else {
    throw new Error("Invalid recovery maintenance action or arguments");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try { await runRecoveryMaintenance(process.argv.slice(2)); } catch {
  // Paths, prompts, and malformed remote/state payloads must not reach deployment logs.
  process.stderr.write("Recovery maintenance refused or failed. Keep services stopped; inspect private state and the retained snapshot offline.\n");
  process.exitCode = 1;
}
}
