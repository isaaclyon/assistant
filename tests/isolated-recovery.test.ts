import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { captureIsolatedRecovery, markIsolatedRecoveryStarted, restoreIsolatedRecovery, setTreeOwnership, type IsolatedRecoverySource } from "../src/isolated-recovery.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "isolated-recovery-"))); roots.push(root);
  const sources: IsolatedRecoverySource[] = [];
  for (const role of ["personal-state", "broker-state", "builder-state", "previous-release"]) {
    const path = join(root, role); await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "evidence"), `accepted-${role}`, { mode: 0o600 });
    sources.push({ role, path, uid: process.getuid!(), gid: process.getgid!(), kind: role.endsWith("release") ? "release" : "state" });
  }
  return { root, sources, snapshot: join(root, "snapshot") };
}
describe("paired recovery across OS identities", () => {
  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("normalizes cross-UID Linux copies and restores the original identity", async () => {
    const f = await fixture();
    const source = { ...f.sources[0]!, uid: 65534, gid: 65534 };
    await setTreeOwnership(source.path, source.uid, source.gid);
    await captureIsolatedRecovery(f.snapshot, [source]);
    expect((await lstat(join(f.snapshot, source.role, "evidence"))).uid).toBe(0);
    await restoreIsolatedRecovery(f.snapshot);
    expect((await lstat(join(source.path, "evidence"))).uid).toBe(source.uid);
    expect(await readFile(join(source.path, "evidence"), "utf8")).toBe(`accepted-${source.role}`);
  });
  it("restores matching pre-start application, runtime and broker evidence", async () => {
    const f = await fixture();
    await writeFile(join(f.sources[0]!.path, ".recovery-maintenance"), "ephemeral", { mode: 0o600 });
    await captureIsolatedRecovery(f.snapshot, f.sources);
    for (const source of f.sources) await writeFile(join(source.path, "evidence"), "pre-start-change");
    await restoreIsolatedRecovery(f.snapshot);
    for (const source of f.sources) expect(await readFile(join(source.path, "evidence"), "utf8")).toBe(`accepted-${source.role}`);
  });
  it("never rewinds runtime or approval decisions after any candidate starts", async () => {
    const f = await fixture(); await captureIsolatedRecovery(f.snapshot, f.sources);
    await markIsolatedRecoveryStarted(f.snapshot);
    await writeFile(join(f.sources[1]!.path, "evidence"), "approval-consumed");
    await expect(restoreIsolatedRecovery(f.snapshot)).rejects.toThrow("candidate started");
    expect(await readFile(join(f.sources[1]!.path, "evidence"), "utf8")).toBe("approval-consumed");
  });
  it("rejects incomplete, modified or reused checkpoints", async () => {
    const f = await fixture(); await captureIsolatedRecovery(f.snapshot, f.sources);
    await expect(captureIsolatedRecovery(f.snapshot, f.sources)).rejects.toThrow();
    await writeFile(join(f.snapshot, "broker-state", "evidence"), "tampered");
    await expect(markIsolatedRecoveryStarted(f.snapshot)).rejects.toThrow("integrity");
    await expect(restoreIsolatedRecovery(f.snapshot)).rejects.toThrow("integrity");
  });
  it("rejects overlapping roots, wrong ownership, and state links", async () => {
    const f = await fixture();
    await expect(captureIsolatedRecovery(join(f.sources[0]!.path, "snapshot"), f.sources)).rejects.toThrow("separate");
    await expect(captureIsolatedRecovery(f.snapshot, [{ ...f.sources[0]!, uid: process.getuid!() + 1 }])).rejects.toThrow("identity");
    await rm(f.snapshot, { recursive: true, force: true });
    await symlink("evidence", join(f.sources[0]!.path, "link"));
    await expect(captureIsolatedRecovery(f.snapshot, f.sources)).rejects.toThrow("Unsafe");
  });
});
