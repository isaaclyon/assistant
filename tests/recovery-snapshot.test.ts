import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRecoverySnapshot, markRecoveryStarted, restoreRecoverySnapshot } from "../src/recovery-snapshot.js";

const roots: string[] = [];
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, cp: vi.fn(fs.cp) };
});
const originalFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => { vi.mocked(cp).mockImplementation(originalFs.cp); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paired-recovery-")); roots.push(root);
  const stateRoot = join(root, "state"); const unitDir = join(root, "units"); const releaseRoot = join(root, "releases");
  const release = join(releaseRoot, "a".repeat(40)); const snapshotDir = join(root, "snapshot");
  for (const path of [stateRoot, unitDir, join(release, "dist", "src")]) await mkdir(path, { recursive: true, mode: 0o700 });
  const unit = 'ExecStart="/usr/bin/node" "' + join(release, "dist", "src", "daemon.js") +
    '"\nEnvironment="PI_TELEGRAM_BRIDGE_STATE_ROOT=' + stateRoot + '"\n';
  await writeFile(join(unitDir, "pi-telegram-bridge-isaac.service"), unit, { mode: 0o600 });
  await writeFile(join(stateRoot, "jobs-state.json"), '{"fired":{"synthetic":1}}', { mode: 0o600 });
  await writeFile(join(stateRoot, "deploy.lock"), "lock inode must survive", { mode: 0o600 });
  await writeFile(join(release, "dist", "src", "daemon.js"), "old binary");
  return { stateRoot, unitDir, releaseRoot, snapshotDir, release, unit };
}
describe("paired recovery snapshot rehearsal", () => {
  it("refuses a previous unit whose state root is outside the captured tree", async () => {
    const f = await fixture();
    await writeFile(join(f.unitDir, "pi-telegram-bridge-isaac.service"), f.unit.replace(f.stateRoot, "/different/state"));
    await expect(captureRecoverySnapshot(f)).rejects.toThrow(/state root/i);
  });
  it("rejects a snapshot parent symlink into the source before creating a destination", async () => {
    const f = await fixture();
    const alias = join(f.stateRoot, "..", "alias");
    await originalFs.symlink(f.stateRoot, alias);
    await expect(captureRecoverySnapshot({ ...f, snapshotDir: join(alias, "snapshot") })).rejects.toThrow(/overlap/i);
    await expect(originalFs.stat(join(f.stateRoot, "snapshot"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects executable or package symlinks that escape the immutable release", async () => {
    const f = await fixture(); const daemon = join(f.release, "dist", "src", "daemon.js");
    await rm(daemon); await originalFs.symlink(join(f.stateRoot, "jobs-state.json"), daemon);
    await expect(captureRecoverySnapshot(f)).rejects.toThrow(/release.*symlink/i);
  });
  it("refuses a state source that changes during capture", async () => {
    const f = await fixture();
    vi.mocked(cp).mockImplementation(async (...args) => {
      await originalFs.cp(...args);
      if (String(args[0]) === join(f.stateRoot, "jobs-state.json")) await writeFile(args[0], "changed after copy");
    });
    await expect(captureRecoverySnapshot(f)).rejects.toThrow(/changed during snapshot/i);
  });
  it("does not report success if restored state is corrupted during copy", async () => {
    const f = await fixture(); await captureRecoverySnapshot(f);
    vi.mocked(cp).mockImplementation(async (...args) => {
      await originalFs.cp(...args);
      if (String(args[1]) === join(f.stateRoot, "jobs-state.json")) await writeFile(args[1], "corrupted destination");
    });
    await expect(restoreRecoverySnapshot(f.snapshotDir)).rejects.toThrow(/restored.*digest/i);
  });
  it("restores matching state, units, and retained binary before candidate startup", async () => {
    const f = await fixture();
    await originalFs.symlink("daemon.js", join(f.release, "dist", "src", "package-alias.js"));
    const { stat } = await import("node:fs/promises"); const lock = await stat(join(f.stateRoot, "deploy.lock"));
    await captureRecoverySnapshot(f);
    await writeFile(join(f.stateRoot, "jobs-state.json"), "changed");
    await writeFile(join(f.stateRoot, "job-occurrences.db"), "partial migration");
    await writeFile(join(f.unitDir, "pi-telegram-bridge-isaac.service"), "new unit");
    await rm(f.release, { recursive: true });
    await restoreRecoverySnapshot(f.snapshotDir);
    expect(await readFile(join(f.stateRoot, "jobs-state.json"), "utf8")).toBe('{"fired":{"synthetic":1}}');
    await expect(stat(join(f.stateRoot, "job-occurrences.db"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.unitDir, "pi-telegram-bridge-isaac.service"), "utf8")).toBe(f.unit);
    expect(await readFile(join(f.release, "dist", "src", "daemon.js"), "utf8")).toBe("old binary");
    expect(await readFile(join(f.release, "dist", "src", "package-alias.js"), "utf8")).toBe("old binary");
    expect((await stat(join(f.stateRoot, "deploy.lock"))).ino).toBe(lock.ino);
  });
  it("refuses rewind after a candidate may have accepted work", async () => {
    const f = await fixture(); await captureRecoverySnapshot(f); await markRecoveryStarted(f.snapshotDir);
    await writeFile(join(f.stateRoot, "accepted-evidence"), "preserve");
    await expect(restoreRecoverySnapshot(f.snapshotDir)).rejects.toThrow(/candidate.*started/i);
    expect(await readFile(join(f.stateRoot, "accepted-evidence"), "utf8")).toBe("preserve");
  });
  it("verifies backup content before changing any destination", async () => {
    const f = await fixture(); await captureRecoverySnapshot(f);
    await writeFile(join(f.snapshotDir, "state", "jobs-state.json"), "corrupt");
    await writeFile(join(f.stateRoot, "jobs-state.json"), "current");
    await expect(restoreRecoverySnapshot(f.snapshotDir)).rejects.toThrow(/digest/i);
    expect(await readFile(join(f.stateRoot, "jobs-state.json"), "utf8")).toBe("current");
  });
});
