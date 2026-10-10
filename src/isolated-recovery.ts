import { randomUUID } from "node:crypto";
import { chown, cp, lchown, lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { digestTree } from "./recovery-snapshot.js";

export interface IsolatedRecoverySource {
  role: string;
  path: string;
  uid: number;
  gid: number;
  kind: "state" | "release" | "unit" | "config";
}
interface Entry extends IsolatedRecoverySource { digest: string; mode: number }
interface Snapshot { version: 1; sources: Entry[] }
const include = (name: string) => ![".recovery-maintenance", "deploy.lock"].includes(name);
const separate = (a: string, b: string) => a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}
export async function writeDurableExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
}

/** Linux copyFile can preserve source ownership when run as root. Normalize
 * copies explicitly before treating them as administrator-owned evidence. */
export async function setTreeOwnership(path: string, uid: number, gid: number): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    await lchown(path, uid, gid);
    return;
  }
  if (!metadata.isDirectory() && !metadata.isFile()) throw new Error("Unsafe ownership target");
  if (metadata.isDirectory()) for (const name of await readdir(path)) await setTreeOwnership(join(path, name), uid, gid);
  await chown(path, uid, gid);
}

function validateSources(snapshotDir: string, sources: IsolatedRecoverySource[]): void {
  if (!sources.length || sources.length > 32) throw new Error("Invalid isolated recovery source count");
  const roles = new Set<string>();
  for (const source of sources) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(source.role) || roles.has(source.role) ||
        !["state", "release", "unit", "config"].includes(source.kind) ||
        ![source.uid, source.gid].every(id => Number.isSafeInteger(id) && id >= 0)) throw new Error("Invalid isolated recovery source");
    roles.add(source.role);
  }
  const paths = [snapshotDir, ...sources.map(source => source.path)];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    if (!isAbsolute(path) || normalize(path) !== path || path === "/" || /[\0\r\n]/.test(path) ||
        paths.slice(i + 1).some(other => !separate(path, other))) throw new Error("Isolated recovery paths must be separate and canonical");
  }
}

/** All user/system units and the trusted poller must be stopped and disabled
 * before this is called. Captures each identity's state with its prior code,
 * broker decisions, configuration and unit files in one retained checkpoint. */
export async function captureIsolatedRecovery(snapshotDir: string, sources: IsolatedRecoverySource[]): Promise<void> {
  validateSources(snapshotDir, sources);
  if (join(await realpath(dirname(snapshotDir)), snapshotDir.split("/").at(-1)!) !== snapshotDir) throw new Error("Noncanonical checkpoint parent");
  for (const source of sources) if (await realpath(source.path) !== source.path) throw new Error("Noncanonical recovery source");
  await mkdir(snapshotDir, { mode: 0o700 });
  const entries: Entry[] = [];
  for (const source of sources) {
    const metadata = await lstat(source.path);
    if (source.kind === "state" && (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700)) throw new Error("State checkpoint requires a private directory");
    const before = await digestTree(source.path, source.kind === "release", false, source.kind === "state" ? include : undefined, source.uid);
    const target = join(snapshotDir, source.role);
    await cp(source.path, target, { recursive: true, verbatimSymlinks: true,
      filter: path => path === source.path || source.kind !== "state" || dirname(path) !== source.path || include(path.split("/").at(-1)!) });
    await setTreeOwnership(target, process.getuid!(), process.getgid!());
    const copied = await digestTree(target, source.kind === "release", true);
    const after = await digestTree(source.path, source.kind === "release", false, source.kind === "state" ? include : undefined, source.uid);
    if (before !== copied || before !== after) throw new Error("Recovery source changed during checkpoint");
    entries.push({ ...source, digest: copied, mode: metadata.mode & 0o777 });
  }
  await writeDurableExclusive(join(snapshotDir, "snapshot.json"), { version: 1, sources: entries } satisfies Snapshot);
}

async function loadSnapshot(snapshotDir: string): Promise<Snapshot> {
  const directory = await lstat(snapshotDir);
  const manifest = await lstat(join(snapshotDir, "snapshot.json"));
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700 ||
      !manifest.isFile() || manifest.uid !== process.getuid?.() || (manifest.mode & 0o777) !== 0o600) throw new Error("Unsafe isolated checkpoint");
  const snapshot: Snapshot = JSON.parse(await readFile(join(snapshotDir, "snapshot.json"), "utf8"));
  if (snapshot.version !== 1 || !Array.isArray(snapshot.sources)) throw new Error("Invalid isolated checkpoint");
  validateSources(snapshotDir, snapshot.sources);
  for (const source of snapshot.sources) {
    if (!/^[a-f0-9]{64}$/.test(source.digest) || !Number.isInteger(source.mode) || source.mode < 0 || source.mode > 0o777 ||
        (await lstat(join(snapshotDir, source.role))).mode % 0o1000 !== source.mode ||
        await digestTree(join(snapshotDir, source.role), source.kind === "release") !== source.digest) throw new Error("Isolated checkpoint integrity check failed");
  }
  return snapshot;
}

export async function markIsolatedRecoveryStarted(snapshotDir: string): Promise<void> {
  await loadSnapshot(snapshotDir);
  await writeDurableExclusive(join(snapshotDir, "candidate-started"), { automaticRewindForbidden: true });
}

/** Offline pre-start only. Current trees are retained beside their paths rather
 * than deleted; restoring after any candidate start is always refused. */
export async function restoreIsolatedRecovery(snapshotDir: string): Promise<void> {
  try { await lstat(join(snapshotDir, "candidate-started")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const snapshot = await loadSnapshot(snapshotDir);
    for (const source of snapshot.sources) {
      const staging = `${source.path}.restore-${randomUUID()}`;
      await cp(join(snapshotDir, source.role), staging, { recursive: true, verbatimSymlinks: true });
      if (await digestTree(staging, source.kind === "release") !== source.digest) throw new Error("Restored checkpoint integrity check failed");
      await setTreeOwnership(staging, source.uid, source.gid);
      if (await digestTree(staging, source.kind === "release", false, undefined, source.uid) !== source.digest) throw new Error("Restored ownership verification failed");
      await rename(source.path, `${source.path}.pre-restore-${randomUUID()}`);
      await rename(staging, source.path);
      await syncDirectory(dirname(source.path));
    }
    return;
  }
  throw new Error("A candidate started; preserve accepted work and reconcile instead of rewinding");
}
