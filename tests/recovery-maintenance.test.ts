import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRecoveryMaintenance } from "../src/recovery-maintenance.js";

const roots: string[] = [];
const oldPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = oldPath;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(active = false) {
  const root = await mkdtemp(join(tmpdir(), "recovery-cli-")); roots.push(root);
  const bin = join(root, "bin"); const state = join(root, "state"); const units = join(root, "units"); const releases = join(root, "releases");
  for (const path of [bin, units, releases, join(state, "instances", "isaac"), join(state, "instances", "emma")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await writeFile(join(bin, "systemctl"), '#!/usr/bin/env bash\n' + (active
    ? 'case "$2" in list-unit*) echo "pi-telegram-bridge-isaac.service enabled";; show) if [[ "$5" == MainPID ]]; then echo 1; elif [[ "$5" == UnitFileState ]]; then echo enabled; else echo active; fi;; esac\n'
    : 'exit 0\n'), { mode: 0o700 });
  process.env.PATH = `${bin}:${oldPath}`;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const snapshot = join(root, "snapshot");
  const args = ["prepare", snapshot, state, units, releases, "none", "isaac", "emma"];
  return { state, snapshot, args };
}

describe("offline recovery maintenance entry point", () => {
  it("rejects a missing coordinator before snapshot, matching fleet installation preflight", async () => {
    const f = await fixture();
    await expect(runRecoveryMaintenance(f.args)).rejects.toThrow(/coordinator/i);
    await expect(stat(f.snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("snapshots and initializes a quiescent fresh fleet", async () => {
    const f = await fixture(); f.args[5] = "isaac"; await runRecoveryMaintenance(f.args);
    expect(JSON.parse(await readFile(join(f.snapshot, "snapshot.json"), "utf8")).version).toBe(1);
    expect((await stat(join(f.state, "instances", "isaac", "job-occurrences.db"))).isFile()).toBe(true);
  });
  it("refuses direct CLI preparation while any service is active", async () => {
    const f = await fixture(true);
    await expect(runRecoveryMaintenance(f.args)).rejects.toThrow(/stopped and disabled/i);
    await expect(stat(f.snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a stopped unit loaded outside the captured unit directory", async () => {
    const f = await fixture(); f.args[5] = "isaac";
    await writeFile(join(process.env.PATH!.split(":")[0]!, "systemctl"), '#!/usr/bin/env bash\ncase "$2" in list-unit*) echo "pi-telegram-bridge-isaac.service disabled";; show) case "$5" in MainPID) echo 0;; UnitFileState) echo disabled;; ActiveState) echo inactive;; FragmentPath) echo /outside/pi-telegram-bridge-isaac.service;; DropInPaths) echo;; esac;; esac\n');
    await expect(runRecoveryMaintenance(f.args)).rejects.toThrow(/captured unit directory/i);
  });
  it("refuses a singleton state root different from its actual environment configuration", async () => {
    const f = await fixture();
    await rm(join(f.state, "instances"), { recursive: true });
    await expect(runRecoveryMaintenance([...f.args.slice(0, 5), "local"])).rejects.toThrow(/state root/i);
  });
  it("refuses an additional scheduler's state instead of ignoring retired coordinator evidence", async () => {
    const f = await fixture(); f.args[5] = "isaac";
    await writeFile(join(f.state, "instances", "emma", "jobs-state.json"), '{"fired":{},"lastRun":{}}', { mode: 0o600 });
    await expect(runRecoveryMaintenance(f.args)).rejects.toThrow(/additional coordinator/i);
  });
});
