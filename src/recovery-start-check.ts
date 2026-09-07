import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationJson } from "./jobs-migration.js";

export async function recoveryStartupAllowed(stateRoot: string, authorization?: string): Promise<boolean> {
  const path = join(stateRoot, ".recovery-maintenance");
  try { await lstat(path); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const { value } = await readMigrationJson(path);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const marker = value as Record<string, unknown>;
    return marker.version === 1 && typeof marker.authorization === "string" &&
      /^[a-f0-9-]{36}$/.test(marker.authorization) && marker.authorization === authorization;
  } catch { return false; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateRoot = process.argv[2];
  if (!stateRoot || !(await recoveryStartupAllowed(stateRoot, process.env.PI_TELEGRAM_RECOVERY_AUTHORIZATION))) {
    process.stderr.write("Recovery maintenance hold prevents service startup.\n");
    process.exitCode = 1; // ExecCondition skip, not a crash/restart loop.
  }
}
