import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, open, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { digestTree } from "./recovery-snapshot.js";
import { setTreeOwnership, writeDurableExclusive } from "./isolated-recovery.js";

export interface MigrationRelocation { from: string; to: string }
export interface MigrationAsset {
  role: string;
  source: string;
  destination: string;
  sourceUid: number;
  uid: number;
  gid: number;
  /** Exact relative entries, selected by the administrator, never glob patterns. */
  exclude: string[];
  transforms: Array<{ path: string; kind: "json-paths" | "session-header" }>;
}
export interface IsolatedMigrationPlan {
  version: 1;
  relocations: MigrationRelocation[];
  assets: MigrationAsset[];
  telegram?: { sourcePath: string; sourceUid: number; profile: string };
}
export interface MigrationInventory { role: string; files: number; bytes: number; excluded: number }
const absolute = (path: unknown): path is string => typeof path === "string" && isAbsolute(path) && normalize(path) === path && path !== "/" && !/[\0\r\n]/.test(path);
const local = (path: unknown): path is string => typeof path === "string" && path !== "" && !isAbsolute(path) && normalize(path) === path && path !== ".." && !path.startsWith("../") && !/[\0\r\n]/.test(path);
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const excluded = (asset: MigrationAsset, path: string) => asset.exclude.some(entry => path === entry || path.startsWith(`${entry}/`));
const parsePrivateJson = (raw: string): unknown => {
  try { return JSON.parse(raw); } catch { throw new Error("Migration JSON is invalid"); }
};
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function validateIsolatedMigrationPlan(plan: IsolatedMigrationPlan): void {
  if (plan.version !== 1 || !Array.isArray(plan.assets) || !plan.assets.length || plan.assets.length > 128 || !Array.isArray(plan.relocations)) throw new Error("Invalid migration plan");
  const roles = new Set<string>();
  for (const asset of plan.assets) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(asset.role) || roles.has(asset.role) || !absolute(asset.source) || !absolute(asset.destination) ||
        ![asset.sourceUid, asset.uid, asset.gid].every(id => Number.isSafeInteger(id) && id >= 0) || !Array.isArray(asset.exclude) ||
        asset.exclude.some(path => !local(path) || path === ".") || !Array.isArray(asset.transforms)) throw new Error("Invalid selected migration asset");
    roles.add(asset.role);
    const transforms = new Set<string>();
    for (const transform of asset.transforms) {
      if (!local(transform.path) || excluded(asset, transform.path) || transforms.has(transform.path) || !["json-paths", "session-header"].includes(transform.kind)) throw new Error("Invalid migration transform");
      transforms.add(transform.path);
    }
  }
  const allPaths = plan.assets.flatMap(asset => [asset.source, asset.destination]);
  if (allPaths.some((path, index) => allPaths.slice(index + 1).some(other => overlaps(path, other)))) throw new Error("Migration assets overlap");
  for (const mapping of plan.relocations) if (!absolute(mapping.from) || !absolute(mapping.to) || mapping.from === mapping.to) throw new Error("Invalid path relocation");
  if (new Set(plan.relocations.map(mapping => mapping.from)).size !== plan.relocations.length) throw new Error("Ambiguous path relocation");
  if (plan.telegram && (!absolute(plan.telegram.sourcePath) || !Number.isSafeInteger(plan.telegram.sourceUid) || plan.telegram.sourceUid < 0 ||
      !/^[a-z0-9]{1,32}$/.test(plan.telegram.profile) || allPaths.some(path => overlaps(path, plan.telegram!.sourcePath)))) throw new Error("Invalid Telegram migration selection");
}

/** Only whole structured path values are rewritten. Embedded shell commands,
 * prompts and other free text require an explicit operator correction. */
export function relocateMigrationJson(value: unknown, mappings: MigrationRelocation[]): unknown {
  if (typeof value === "string") {
    const matches = mappings.filter(mapping => value === mapping.from || value.startsWith(`${mapping.from}/`)).sort((a, b) => b.from.length - a.from.length);
    if (matches[0]) return matches[0].to + value.slice(matches[0].from.length);
    if (mappings.some(mapping => value.includes(`${mapping.from}/`) || value.includes(`${mapping.from}"`) || value.endsWith(mapping.from))) throw new Error("Migration contains an embedded path requiring explicit correction");
    return value;
  }
  if (Array.isArray(value)) return value.map(entry => relocateMigrationJson(entry, mappings));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [String(relocateMigrationJson(key, mappings)), relocateMigrationJson(entry, mappings)]));
  return value;
}

export function relocateSessionHeader(raw: string, mappings: MigrationRelocation[]): string {
  const newline = raw.indexOf("\n");
  const header = parsePrivateJson(newline < 0 ? raw : raw.slice(0, newline)) as { type?: unknown; cwd?: unknown } | null;
  if (!header || header.type !== "session" || typeof header.cwd !== "string") throw new Error("Invalid migration session header");
  return JSON.stringify(relocateMigrationJson(header, mappings)) + (newline < 0 ? "" : raw.slice(newline));
}

async function transformedFile(path: string, kind: MigrationAsset["transforms"][number]["kind"], mappings: MigrationRelocation[]): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 128 * 1024 * 1024) throw new Error("Unsafe migration transform source");
  const raw = await readFile(path, "utf8");
  return kind === "session-header" ? relocateSessionHeader(raw, mappings) : JSON.stringify(relocateMigrationJson(parsePrivateJson(raw), mappings), null, 2) + "\n";
}

/** Content-free inventory; never treats a live copy as an accepted checkpoint. */
export async function inventoryIsolatedMigration(plan: IsolatedMigrationPlan): Promise<MigrationInventory[]> {
  validateIsolatedMigrationPlan(plan);
  const output: MigrationInventory[] = [];
  for (const asset of plan.assets) {
    if (await realpath(asset.source) !== asset.source || await realpath(dirname(asset.destination)) !== dirname(asset.destination)) throw new Error("Noncanonical migration asset");
    const summary: MigrationInventory = { role: asset.role, files: 0, bytes: 0, excluded: 0 };
    let entries = 0;
    async function walk(path: string): Promise<void> {
      if (++entries > 250_000) throw new Error("Migration inventory file limit exceeded");
      const name = relative(asset.source, path);
      if (name && excluded(asset, name)) { summary.excluded++; return; }
      const info = await lstat(path);
      if (info.uid !== asset.sourceUid) throw new Error("Migration source ownership mismatch");
      if (info.isSymbolicLink()) throw new Error("Migration source link requires explicit selection or exclusion");
      if (info.isDirectory()) {
        for (const entry of await readdir(path)) await walk(join(path, entry));
      } else {
        if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe migration source");
        summary.files++; summary.bytes += info.size;
      }
    }
    await walk(asset.source);
    for (const transform of asset.transforms) await transformedFile(join(asset.source, transform.path), transform.kind, plan.relocations);
    output.push(summary);
  }
  return output;
}

async function selectedDigest(asset: MigrationAsset): Promise<string> {
  // Hash the same selected entries as cp; unlike digestTree's top-level filter,
  // migration exclusions can name individual nested browser lock files.
  const hash = createHash("sha256");
  async function walk(path: string): Promise<void> {
    const name = relative(asset.source, path);
    if (name && excluded(asset, name)) return;
    const metadata = await lstat(path);
    if (metadata.uid !== asset.sourceUid || metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))) throw new Error("Migration source changed during copy");
    hash.update(JSON.stringify([name, name === "" ? 0 : metadata.mode & 0o777]));
    if (metadata.isDirectory()) {
      hash.update("directory");
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
    } else {
      hash.update(`file:${metadata.size}:`);
      const handle = await open(path, "r");
      try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); }
    }
  }
  await walk(asset.source);
  return hash.digest("hex");
}

/** Called inside the deployment hold after all affected writers stop. Retains
 * original selected bytes and replaced destinations. A partial migration is
 * held for inspection; a completed one is idempotent only while unchanged. */
export async function applyIsolatedMigration(plan: IsolatedMigrationPlan, checkpoint: string, assertQuiescent: () => Promise<void>): Promise<void> {
  await assertQuiescent();
  if (await exists(join(checkpoint, "candidate-started"))) throw new Error("A candidate started; migration refresh is forbidden");
  validateIsolatedMigrationPlan(plan);
  if (!absolute(checkpoint) || plan.assets.some(asset => overlaps(checkpoint, asset.source) || overlaps(checkpoint, asset.destination))) throw new Error("Migration checkpoint overlaps assets");
  const metadata = await lstat(checkpoint);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700 || await realpath(checkpoint) !== checkpoint) throw new Error("Unsafe migration checkpoint");
  const planDigest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const complete = join(checkpoint, "migration-complete.json");
  if (await exists(complete)) {
    const record = JSON.parse(await readFile(complete, "utf8"));
    if (record.planDigest !== planDigest) throw new Error("Completed migration plan changed");
    for (const asset of plan.assets) if (await digestTree(asset.destination, false, false, undefined, asset.uid) !== record.destinations[asset.role]) throw new Error("Completed migration destination changed");
    return;
  }
  await inventoryIsolatedMigration(plan);
  await writeDurableExclusive(join(checkpoint, "migration-started.json"), { planDigest, plan });
  const prepared: Array<{ asset: MigrationAsset; staging: string; digest: string }> = [];
  for (const asset of plan.assets) {
    const original = join(checkpoint, `migration-source-${asset.role}`);
    const before = await selectedDigest(asset);
    await cp(asset.source, original, { recursive: true, filter: path => !excluded(asset, relative(asset.source, path)) });
    await setTreeOwnership(original, process.getuid!(), process.getgid!());
    if (await digestTree(original, false, true) !== before || await selectedDigest(asset) !== before) throw new Error("Migration source changed during checkpoint");
    const staging = `${asset.destination}.migration-${randomUUID()}`;
    await cp(original, staging, { recursive: true });
    for (const transform of asset.transforms) {
      const path = join(staging, transform.path);
      await writeFile(path, await transformedFile(path, transform.kind, plan.relocations));
    }
    const digest = await digestTree(staging, false, true);
    await setTreeOwnership(staging, asset.uid, asset.gid);
    prepared.push({ asset, staging, digest });
  }
  await assertQuiescent();
  for (const { asset, staging, digest } of prepared) {
    if (await digestTree(staging, false, false, undefined, asset.uid) !== digest) throw new Error("Migration staging changed");
    if (await exists(asset.destination)) await rename(asset.destination, `${asset.destination}.pre-migration-${randomUUID()}`);
    await rename(staging, asset.destination);
    const directory = await open(dirname(asset.destination), "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  await writeDurableExclusive(complete, { planDigest, destinations: Object.fromEntries(prepared.map(entry => [entry.asset.role, entry.digest])) });
}
