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
): BridgeConfig {
  const cwd = resolveFromHome(env.PI_TELEGRAM_BRIDGE_CWD, home, home);
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
  } catch {
    return undefined;
  }
}

export async function hasConfiguredTelegramToken(path: string): Promise<boolean> {
  const config = await readJsonObject(path);
  return typeof config?.botToken === "string" && config.botToken.trim().length > 0;
}

export async function hasDefaultTelegramLock(path: string): Promise<boolean> {
  const locks = await readJsonObject(path);
  return typeof locks?.["@llblab/pi-telegram"] === "object";
}
