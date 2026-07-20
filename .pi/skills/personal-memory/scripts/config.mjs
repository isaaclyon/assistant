import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_MEMORY_RELATIVE_PATH = join(
  ".local",
  "share",
  "pi-telegram-bridge",
  "memory",
);
export const DEFAULT_BRIDGE_STATE_RELATIVE_PATH = join(
  ".local",
  "state",
  "pi-telegram-bridge",
);

/** Resolve the canonical memory root for one CLI invocation. */
export function resolveMemoryDirectory(env = process.env, home = homedir()) {
  const configured = env.PI_TELEGRAM_MEMORY_DIR?.trim();
  if (!configured) return join(home, DEFAULT_MEMORY_RELATIVE_PATH);
  return isAbsolute(configured) ? resolve(configured) : resolve(home, configured);
}

/** Resolve the explicit opt-in for local Git commits after memory mutations. */
export function resolveMemoryGitAutocommit(env = process.env) {
  const configured = env.PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT?.trim();
  if (!configured || configured === "0") return false;
  if (configured === "1") return true;
  throw new Error("PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT must be 0 or 1");
}

/** Resolve the bridge session directory used by source-footnote validation. */
export function resolveBridgeSessionDirectory(env = process.env, home = homedir()) {
  const configured = env.PI_TELEGRAM_BRIDGE_STATE_DIR?.trim();
  const stateRoot = configured
    ? (isAbsolute(configured) ? resolve(configured) : resolve(home, configured))
    : join(home, DEFAULT_BRIDGE_STATE_RELATIVE_PATH);
  return join(stateRoot, "sessions");
}
