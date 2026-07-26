import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const LEGACY_STATE_ENTRIES = new Set([
  "checkers",
  "inbox.db",
  "inbox.db-shm",
  "inbox.db-wal",
  "jobs-state.json",
  "conversation-session-state.json",
  "jobs.json",
  "pi-codex-conversion.json",
  "restart-pending.json",
  "search-index.db",
  "sessions",
  "webhook-secret",
]);

const LEGACY_STATE_SHARED_ENTRIES = new Set(["deploy.lock"]);

export interface LegacyStateMigrationOptions {
  stateRoot: string;
  instanceId: string;
  now?: () => Date;
}

export interface LegacyStateMigrationResult {
  source: string;
  destination: string;
  copiedEntries: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoSymlinks(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Legacy state contains a symbolic link: ${path}`);
  }
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await assertNoSymlinks(join(path, entry));
  }
}

async function hardenPrivateModes(path: string): Promise<void> {
  const metadata = await lstat(path);
  await chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await hardenPrivateModes(join(path, entry));
  }
}

export async function migrateLegacyStateToInstance({
  stateRoot,
  instanceId,
  now = () => new Date(),
}: LegacyStateMigrationOptions): Promise<LegacyStateMigrationResult> {
  if (!isAbsolute(stateRoot)) {
    throw new Error("Legacy state root must be an absolute path");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(instanceId)) {
    throw new Error("Migration instance ID must be a lowercase slug");
  }
  const source = resolve(stateRoot);
  const entries = (await readdir(source))
    .filter(
      (entry) =>
        entry !== "instances" && !LEGACY_STATE_SHARED_ENTRIES.has(entry),
    )
    .sort();
  const unknownEntries = entries.filter((entry) => !LEGACY_STATE_ENTRIES.has(entry));
  if (unknownEntries.length > 0) {
    throw new Error(
      `Unknown legacy state blocks migration: ${unknownEntries.join(", ")}. Move or classify these entries before retrying.`,
    );
  }

  const instancesDir = join(source, "instances");
  const destination = join(instancesDir, instanceId);
  const staging = join(instancesDir, `.${instanceId}.migrating`);
  if (await pathExists(destination)) {
    throw new Error(
      `Migration destination already exists: ${destination}. Inspect it and restore or remove it explicitly before retrying.`,
    );
  }
  if (await pathExists(staging)) {
    throw new Error(
      `Migration staging directory already exists: ${staging}. Inspect and remove it explicitly before retrying.`,
    );
  }

  await mkdir(instancesDir, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const sourcePath = join(source, entry);
      await assertNoSymlinks(sourcePath);
      await cp(sourcePath, join(staging, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    await writeFile(
      join(staging, "migration.json"),
      `${JSON.stringify(
        {
          version: 1,
          source,
          instanceId,
          migratedAt: now().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await hardenPrivateModes(staging);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return { source, destination, copiedEntries: entries };
}
