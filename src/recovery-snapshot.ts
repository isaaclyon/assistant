import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readMigrationJson } from "./jobs-migration.js";

const unitPattern = /^pi-telegram-bridge(?:-[a-z0-9-]{1,64})?\.service$/;
const excludedState = new Set(["deploy.lock", ".recovery-maintenance"]);
interface Snapshot {
  version: 1;
  stateRoot: string;
  unitDir: string;
  releaseRoot: string;
  stateDigest: string;
  unitDigest: string;
  releases: Record<string, string>;
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new Error("Recovery snapshot requires a private owned directory");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function digestTree(root: string, allowLinks: boolean, sync = false,
  includeRootEntry: (name: string) => boolean = () => true): Promise<string> {
  const hash = createHash("sha256");
  const canonicalRoot = await realpath(root);
  let count = 0;
  async function walk(path: string): Promise<void> {
    if (++count > 250_000) throw new Error("Recovery snapshot file limit exceeded");
    const info = await lstat(path);
    if (info.uid !== process.getuid?.()) throw new Error("Recovery source is not owned by the service user");
    const name = relative(root, path);
    hash.update(JSON.stringify([name, name === "" ? 0 : info.mode & 0o777]));
    if (info.isSymbolicLink() && allowLinks) {
      const target = await readlink(path);
      // Relative in-tree package links remain self-contained when copied.
      // Their target bytes are independently visited and hashed in this tree.
      if (!name || isAbsolute(target) || !resolve(dirname(path), target).startsWith(`${root}/`) ||
          !(await realpath(path)).startsWith(`${canonicalRoot}/`)) throw new Error("Release symlink escapes the immutable tree");
      hash.update(JSON.stringify(["link", target])); return;
    }
    if (info.isDirectory()) {
      hash.update("directory");
      for (const entry of (await readdir(path)).sort()) {
        if (name !== "" || includeRootEntry(entry)) await walk(join(path, entry));
      }
      if (sync) await syncDirectory(path);
      return;
    }
    if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe recovery snapshot entry");
    hash.update(`file:${info.size}:`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if (position !== info.size) throw new Error("Recovery source changed during snapshot");
      if (sync) await handle.sync();
    } finally { await handle.close(); }
  }
  await walk(root);
  return hash.digest("hex");
}

function assertSeparatePaths(snapshotDir: string, paths: string[]): void {
  for (const path of [snapshotDir, ...paths]) {
    if (!isAbsolute(path) || resolve(path) !== path || path === "/") throw new Error("Invalid recovery path");
  }
  const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (paths.some((path) => overlaps(path, snapshotDir)) ||
      paths.some((path, i) => paths.slice(i + 1).some((other) => overlaps(path, other)))) {
    throw new Error("Recovery paths must not overlap");
  }
}

async function assertCanonicalSeparation(snapshotDir: string, paths: string[]): Promise<void> {
  assertSeparatePaths(snapshotDir, paths);
  const canonicalSnapshot = join(await realpath(dirname(snapshotDir)), basename(snapshotDir));
  assertSeparatePaths(canonicalSnapshot, await Promise.all(paths.map((path) => realpath(path))));
}

/** Call only after stopping and disabling all bridge units and pausing external writers. */
export async function captureRecoverySnapshot(options: {
  stateRoot: string; unitDir: string; releaseRoot: string; snapshotDir: string;
}): Promise<void> {
  const { stateRoot, unitDir, releaseRoot, snapshotDir } = options;
  await assertCanonicalSeparation(snapshotDir, [stateRoot, unitDir, releaseRoot]);
  await privateDirectory(stateRoot);
  await mkdir(snapshotDir, { mode: 0o700 }); // Never overwrite or reuse an incomplete snapshot.
  const state = join(snapshotDir, "state"); const units = join(snapshotDir, "units");
  await mkdir(state, { mode: 0o700 }); await mkdir(units, { mode: 0o700 });
  for (const name of await readdir(stateRoot)) {
    if (!excludedState.has(name)) await cp(join(stateRoot, name), join(state, name), { recursive: true, verbatimSymlinks: true });
  }
  const releases: Record<string, string> = {};
  for (const name of (await readdir(unitDir)).filter((name) => unitPattern.test(name)).sort()) {
    const path = join(unitDir, name);
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 || info.uid !== process.getuid?.()) throw new Error("Unsafe bridge unit");
    const raw = await readFile(path, "utf8");
    const statePaths = [...raw.matchAll(/^Environment=("(?:\\.|[^"\\])*")$/gm)]
      .map((match) => JSON.parse(match[1]!) as string)
      .filter((value) => /^PI_TELEGRAM_BRIDGE_STATE_(?:ROOT|DIR)=/.test(value))
      .map((value) => value.slice(value.indexOf("=") + 1));
    if (statePaths.length !== 1 || statePaths[0] !== stateRoot) throw new Error("Previous unit state root does not match the recovery snapshot");
    const match = /^ExecStart=("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/m.exec(raw);
    if (!match) throw new Error("Cannot prove previous bridge binary path");
    const executable: unknown = JSON.parse(match[2]!);
    if (typeof executable !== "string" || !executable.endsWith("/dist/src/daemon.js")) throw new Error("Invalid previous bridge binary");
    const release = dirname(dirname(dirname(executable)));
    const sha = relative(releaseRoot, release);
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Previous bridge binary is not an immutable release");
    const daemon = await lstat(executable);
    if (!daemon.isFile() || daemon.nlink !== 1 || daemon.uid !== process.getuid?.()) throw new Error("Release executable must not be a symlink or shared file");
    await cp(path, join(units, name));
    if (Object.hasOwn(releases, sha)) continue;
    const target = join(snapshotDir, "releases", sha);
    await cp(release, target, { recursive: true, verbatimSymlinks: true });
    releases[sha] = await digestTree(target, true, true);
    if (await digestTree(release, true) !== releases[sha]) throw new Error("Previous release changed during snapshot");
  }
  const snapshot: Snapshot = { version: 1, stateRoot, unitDir, releaseRoot,
    stateDigest: await digestTree(state, false, true), unitDigest: await digestTree(units, false, true), releases };
  if (await digestTree(stateRoot, false, false, (name) => !excludedState.has(name)) !== snapshot.stateDigest ||
      await digestTree(unitDir, false, false, (name) => unitPattern.test(name)) !== snapshot.unitDigest) {
    throw new Error("Recovery state or units changed during snapshot");
  }
  const handle = await open(join(snapshotDir, "snapshot.json.tmp"), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); } finally { await handle.close(); }
  await rename(join(snapshotDir, "snapshot.json.tmp"), join(snapshotDir, "snapshot.json"));
  await syncDirectory(snapshotDir); await syncDirectory(dirname(snapshotDir));
}

async function loadSnapshot(snapshotDir: string): Promise<Snapshot> {
  await privateDirectory(snapshotDir);
  const { value } = await readMigrationJson(join(snapshotDir, "snapshot.json"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery snapshot");
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.stateRoot !== "string" || typeof v.unitDir !== "string" || typeof v.releaseRoot !== "string" ||
      typeof v.stateDigest !== "string" || typeof v.unitDigest !== "string" ||
      !v.releases || typeof v.releases !== "object" || Array.isArray(v.releases) ||
      Object.entries(v.releases).some(([sha, digest]) => !/^[a-f0-9]{40}$/.test(sha) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
    throw new Error("Invalid recovery snapshot manifest");
  }
  await assertCanonicalSeparation(snapshotDir, [v.stateRoot, v.unitDir, v.releaseRoot]);
  return v as unknown as Snapshot;
}

/** Durable irreversible barrier, written before the first possible candidate process. */
export async function markRecoveryStarted(snapshotDir: string): Promise<void> {
  await loadSnapshot(snapshotDir);
  const file = await open(join(snapshotDir, "candidate-started"), "wx", 0o600);
  try { await file.writeFile("Automatic state rewind is forbidden.\n"); await file.sync(); } finally { await file.close(); }
  await syncDirectory(snapshotDir);
}

/** Offline pre-start restore only. Never starts/enables a unit; an operator verifies recovery. */
export async function restoreRecoverySnapshot(snapshotDir: string): Promise<void> {
  const snapshot = await loadSnapshot(snapshotDir);
  try {
    await lstat(join(snapshotDir, "candidate-started"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = join(snapshotDir, "state"); const units = join(snapshotDir, "units");
    if (await digestTree(state, false) !== snapshot.stateDigest || await digestTree(units, false) !== snapshot.unitDigest) {
      throw new Error("Recovery snapshot digest mismatch");
    }
    for (const [sha, digest] of Object.entries(snapshot.releases)) {
      if (await digestTree(join(snapshotDir, "releases", sha), true) !== digest) throw new Error("Recovery binary digest mismatch");
    }
    await privateDirectory(snapshot.stateRoot);
    for (const name of await readdir(snapshot.stateRoot)) {
      if (!excludedState.has(name)) await rm(join(snapshot.stateRoot, name), { recursive: true, force: true });
    }
    for (const name of await readdir(state)) await cp(join(state, name), join(snapshot.stateRoot, name), { recursive: true });
    for (const name of (await readdir(snapshot.unitDir)).filter((name) => unitPattern.test(name))) await rm(join(snapshot.unitDir, name));
    for (const name of await readdir(units)) await cp(join(units, name), join(snapshot.unitDir, name));
    for (const sha of Object.keys(snapshot.releases)) {
      const destination = join(snapshot.releaseRoot, sha);
      await rm(destination, { recursive: true, force: true });
      await cp(join(snapshotDir, "releases", sha), destination, { recursive: true, verbatimSymlinks: true });
      if (await digestTree(destination, true, true) !== snapshot.releases[sha]) throw new Error("Restored binary digest mismatch");
    }
    // Keep the snapshot and maintenance marker for explicit service recovery.
    if (await digestTree(snapshot.stateRoot, false, true, (name) => !excludedState.has(name)) !== snapshot.stateDigest ||
        await digestTree(snapshot.unitDir, false, true, (name) => unitPattern.test(name)) !== snapshot.unitDigest) {
      throw new Error("Restored state or units digest mismatch");
    }
    await syncDirectory(snapshot.stateRoot); await syncDirectory(snapshot.unitDir);
    return;
  }
  throw new Error("Candidate may have started; state rewind is forbidden. Preserve evidence and reconcile or roll forward.");
}
