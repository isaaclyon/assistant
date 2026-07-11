import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface BridgeConfig {
  agentDir: string;
  cwd: string;
  sessionDir: string;
  stateDir: string;
}

type BridgeEnvironment = Readonly<Record<string, string | undefined>>;

function resolveFromHome(value: string | undefined, fallback: string, home: string): string {
  const selected = value?.trim() || fallback;
  return isAbsolute(selected) ? resolve(selected) : resolve(home, selected);
}

export function resolveBridgeConfig(
  env: BridgeEnvironment = process.env,
  home = homedir(),
  defaultCwd = process.cwd(),
): BridgeConfig {
  const cwd = resolveFromHome(env.PI_TELEGRAM_BRIDGE_CWD, defaultCwd, home);
  const agentDir = resolveFromHome(
    env.PI_CODING_AGENT_DIR,
    join(home, ".pi", "agent"),
    home,
  );
  const stateDir = resolveFromHome(
    env.PI_TELEGRAM_BRIDGE_STATE_DIR,
    join(home, ".local", "state", "pi-telegram-bridge"),
    home,
  );

  return {
    agentDir,
    cwd,
    sessionDir: join(stateDir, "sessions"),
    stateDir,
  };
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read JSON file ${path}: ${message}`, { cause: error });
  }
}

export async function hasConfiguredTelegramToken(path: string): Promise<boolean> {
  const config = await readJsonObject(path);
  return typeof config?.botToken === "string" && config.botToken.trim().length > 0;
}

export interface TelegramLockView {
  pid: number;
  cwd?: string;
  heartbeatMs?: number;
}

export async function readDefaultTelegramLock(
  path: string,
): Promise<TelegramLockView | undefined> {
  const locks = await readJsonObject(path);
  const value = locks?.["@llblab/pi-telegram"];
  if (typeof value !== "object" || value === null) return undefined;
  const lock = value as Record<string, unknown>;
  if (
    typeof lock.pid !== "number" ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 0
  ) {
    return undefined;
  }
  return {
    pid: lock.pid,
    ...(typeof lock.cwd === "string" ? { cwd: lock.cwd } : {}),
    ...(typeof lock.heartbeatMs === "number" && Number.isFinite(lock.heartbeatMs)
      ? { heartbeatMs: lock.heartbeatMs }
      : {}),
  };
}

export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = process.kill,
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Keep this aligned with the full-commit-pinned pi-telegram lock runtime.
export const TELEGRAM_LOCK_STALE_HEARTBEAT_MS = 5_000;

export function shouldRecoverTelegramOwnership(
  lock: TelegramLockView | undefined,
  currentPid: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
  nowMs = Date.now(),
  staleHeartbeatMs = TELEGRAM_LOCK_STALE_HEARTBEAT_MS,
): boolean {
  if (!lock) return true;
  if (
    lock.heartbeatMs !== undefined &&
    nowMs - lock.heartbeatMs > staleHeartbeatMs
  ) {
    return true;
  }
  if (lock.pid === currentPid) return false;
  return !isAlive(lock.pid);
}
