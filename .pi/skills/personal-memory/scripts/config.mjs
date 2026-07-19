import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_MEMORY_RELATIVE_PATH = join(
  ".local",
  "share",
  "pi-telegram-bridge",
  "memory",
);

/** Resolve the canonical memory root for one CLI invocation. */
export function resolveMemoryDirectory(env = process.env, home = homedir()) {
  const configured = env.PI_TELEGRAM_MEMORY_DIR?.trim();
  if (!configured) return join(home, DEFAULT_MEMORY_RELATIVE_PATH);
  return isAbsolute(configured) ? resolve(configured) : resolve(home, configured);
}

