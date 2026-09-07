import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

export class MutationBusyError extends Error {
  code = "MUTATION_BUSY";
  constructor() {
    super("Another mutation is in progress. Retry after it finishes.");
    this.name = "MutationBusyError";
  }
}

/**
 * A cooperative, process-crash-safe mutex, not a domain database. SQLite's
 * reserved lock releases on close/process death. Never unlink this sidecar:
 * replacing its inode would let two processes hold different locks.
 * A private owned parent prevents another principal replacing the lock inode.
 */
export async function withMutationLock(path, operation, { timeoutMs = 5_000 } = {}) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 ||
      (process.getuid && parent.uid !== process.getuid())) {
    throw new Error("Mutation lock requires a private, owned directory");
  }
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 ||
      (process.getuid && metadata.uid !== process.getuid())) {
    throw new Error("Mutation lock must be a private, owned regular file");
  }
  const db = new DatabaseSync(path, { timeout: 0 });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  try {
    while (!held) {
      try {
        db.exec("BEGIN IMMEDIATE");
        held = true;
      } catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
        if (Date.now() >= deadline) throw new MutationBusyError();
        await delay(25);
      }
    }
    return await operation();
  } finally {
    try {
      if (held) db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}
