import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  type BridgeInstanceManifest,
  type BridgeJobsRole,
  type BridgeMemoryView,
  type BridgePrincipal,
  type BridgeTelegramSurface,
  loadBridgeInstanceManifest,
  resolveBridgeInstancePaths,
  selectBridgeInstance,
} from "./instances.js";
import { validateCredentialEnvironmentFile } from "./credential-environment.js";

export interface BridgeConfig {
  agentDir: string;
  codexConfigPath: string;
  cwd: string;
  sessionDir: string;
  sessionIdleMs?: number;
  stateDir: string;
  webhookHost: string;
  webhookPort: number;
}

export interface BridgeInstanceConfig {
  instanceId: string;
  displayName: string;
  principal: BridgePrincipal;
  telegramProfile: string;
  telegramSurface: BridgeTelegramSurface;
  resourceRoot: string;
  workspaceCwd: string;
  capabilityProfile: string;
  credentialScope: string;
  memoryView: BridgeMemoryView;
  jobsRole: BridgeJobsRole;
  configuredInstanceIds: string[];
  jobsCoordinatorId?: string;
  agentDir: string;
  stateRoot: string;
  configRoot: string;
  stateDir: string;
  sessionDir: string;
  sessionIdleMs?: number;
  inboxPath: string;
  codexConfigPath: string;
  restartMarkerPath: string;
  runtimeMetadataPath: string;
  checkerStateDir: string;
  environmentFilePath: string;
  webhookHost: string;
  webhookPort: number;
}

type BridgeEnvironment = Readonly<Record<string, string | undefined>>;

const MAX_SESSION_IDLE_HOURS = 8_760;

function resolveSessionIdleMs(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return 0;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_SESSION_IDLE_HOURS) {
    throw new Error(
      `PI_TELEGRAM_SESSION_IDLE_HOURS must be 0 (disabled) or a finite number up to ${MAX_SESSION_IDLE_HOURS}: ${raw}`,
    );
  }
  return hours * 60 * 60 * 1_000;
}

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
  const codexConfigPath = resolveFromHome(
    env.PI_TELEGRAM_CODEX_CONFIG,
    join(stateDir, "pi-codex-conversion.json"),
    home,
  );

  const webhookPortRaw = env.PI_TELEGRAM_BRIDGE_WEBHOOK_PORT?.trim();
  const webhookPort = webhookPortRaw ? Number.parseInt(webhookPortRaw, 10) : 8776;
  if (!Number.isInteger(webhookPort) || webhookPort < 0 || webhookPort > 65_535) {
    throw new Error(
      `PI_TELEGRAM_BRIDGE_WEBHOOK_PORT must be a port number: ${webhookPortRaw}`,
    );
  }

  return {
    agentDir,
    codexConfigPath,
    cwd,
    sessionDir: join(stateDir, "sessions"),
    sessionIdleMs: resolveSessionIdleMs(env.PI_TELEGRAM_SESSION_IDLE_HOURS),
    stateDir,
    webhookHost: env.PI_TELEGRAM_BRIDGE_WEBHOOK_HOST?.trim() || "127.0.0.1",
    webhookPort,
  };
}

export function resolveBridgeInstanceConfig(
  manifest: BridgeInstanceManifest,
  instanceId: string,
  env: BridgeEnvironment = process.env,
  home = homedir(),
  defaultResourceRoot = process.cwd(),
): BridgeInstanceConfig {
  const instance = selectBridgeInstance(manifest, instanceId);
  const resourceRoot = resolveFromHome(
    env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT,
    defaultResourceRoot,
    home,
  );
  const stateRoot = resolveFromHome(
      env.PI_TELEGRAM_BRIDGE_STATE_ROOT,
      join(home, ".local", "state", "pi-telegram-bridge"),
      home,
    );
  const configRoot = resolveFromHome(
      env.PI_TELEGRAM_BRIDGE_CONFIG_ROOT,
      join(home, ".config", "pi-telegram-bridge"),
      home,
    );
  const paths = resolveBridgeInstancePaths(instance, { stateRoot, configRoot });
  const webhookPortRaw = env.PI_TELEGRAM_BRIDGE_WEBHOOK_PORT?.trim();
  const webhookPort = webhookPortRaw ? Number.parseInt(webhookPortRaw, 10) : 8776;
  if (!Number.isInteger(webhookPort) || webhookPort < 0 || webhookPort > 65_535) {
    throw new Error(
      `PI_TELEGRAM_BRIDGE_WEBHOOK_PORT must be a port number: ${webhookPortRaw}`,
    );
  }

  return {
    instanceId: instance.id,
    displayName: instance.displayName,
    principal: instance.principal,
    telegramProfile: instance.telegramProfile,
    telegramSurface: instance.telegramSurface,
    resourceRoot,
    workspaceCwd: instance.workspaceCwd,
    capabilityProfile: instance.capabilityProfile,
    credentialScope: instance.credentialScope,
    memoryView: instance.memoryView,
    jobsRole: instance.jobsRole,
    configuredInstanceIds: manifest.instances.map((candidate) => candidate.id),
    ...(manifest.instances.find((candidate) => candidate.jobsRole === "coordinator")
      ?.id === undefined
      ? {}
      : {
          jobsCoordinatorId: manifest.instances.find(
            (candidate) => candidate.jobsRole === "coordinator",
          )!.id,
        }),
    agentDir: resolveFromHome(
      env.PI_CODING_AGENT_DIR,
      join(home, ".pi", "agent"),
      home,
    ),
    stateRoot,
    configRoot,
    ...paths,
    sessionIdleMs: resolveSessionIdleMs(env.PI_TELEGRAM_SESSION_IDLE_HOURS),
    webhookHost: env.PI_TELEGRAM_BRIDGE_WEBHOOK_HOST?.trim() || "127.0.0.1",
    webhookPort,
  };
}

export async function loadBridgeInstanceConfig(
  env: BridgeEnvironment = process.env,
  home = homedir(),
  defaultResourceRoot = process.cwd(),
): Promise<BridgeInstanceConfig> {
  const configRoot = resolveFromHome(
    env.PI_TELEGRAM_BRIDGE_CONFIG_ROOT,
    join(home, ".config", "pi-telegram-bridge"),
    home,
  );
  const manifestPath = resolveFromHome(
    env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST,
    join(configRoot, "instances.json"),
    home,
  );
  const instanceId = env.PI_TELEGRAM_BRIDGE_INSTANCE_ID?.trim();
  if (!instanceId) {
    throw new Error("PI_TELEGRAM_BRIDGE_INSTANCE_ID must select one bridge instance");
  }
  const manifest = await loadBridgeInstanceManifest(manifestPath);
  const config = resolveBridgeInstanceConfig(
    manifest,
    instanceId,
    env,
    home,
    defaultResourceRoot,
  );
  await validateCredentialEnvironmentFile(
    config.environmentFilePath,
    config.credentialScope,
  );
  return config;
}

export async function loadBridgeRuntimeConfig(
  env: BridgeEnvironment = process.env,
  home = homedir(),
  defaultRuntimeRoot = process.cwd(),
): Promise<BridgeConfig | BridgeInstanceConfig> {
  const instanceMigrationConfigured = Boolean(
    env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST?.trim() ||
      env.PI_TELEGRAM_BRIDGE_INSTANCE_ID?.trim(),
  );
  if (instanceMigrationConfigured) {
    return loadBridgeInstanceConfig(env, home, defaultRuntimeRoot);
  }
  return resolveBridgeConfig(env, home, defaultRuntimeRoot);
}

export async function ensureCodexConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const initialConfig = {
    mode: "normal",
    tools: { imageGeneration: false, imageGenerationOnly: false },
  };
  try {
    await writeFile(
      path,
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse Codex configuration: ${path}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Codex configuration must be a JSON object: ${path}`);
  }
  const config = parsed as Record<string, unknown>;
  const existingTools = config.tools;
  if (
    typeof existingTools === "object" &&
    existingTools !== null &&
    !Array.isArray(existingTools) &&
    (existingTools as Record<string, unknown>).imageGeneration === false &&
    (existingTools as Record<string, unknown>).imageGenerationOnly === false
  ) {
    return;
  }

  const tools =
    typeof existingTools === "object" &&
    existingTools !== null &&
    !Array.isArray(existingTools)
      ? (existingTools as Record<string, unknown>)
      : {};
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          ...config,
          tools: {
            ...tools,
            imageGeneration: false,
            imageGenerationOnly: false,
          },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function hasConfiguredTelegramToken(
  path: string,
  profileName = "default",
): Promise<boolean> {
  const config = await readJsonObject(path);
  const profile =
    profileName === "default"
      ? config
      : isJsonObject(config?.profiles)
        ? config.profiles[profileName]
        : undefined;
  return (
    isJsonObject(profile) &&
    typeof profile.botToken === "string" &&
    profile.botToken.trim().length > 0
  );
}

export interface TelegramLockView {
  pid: number;
  cwd?: string;
  heartbeatMs?: number;
}

export async function readDefaultTelegramLock(
  path: string,
): Promise<TelegramLockView | undefined> {
  return readTelegramLock(path, "default");
}

export async function readTelegramLock(
  path: string,
  profileName: string,
): Promise<TelegramLockView | undefined> {
  const locks = await readJsonObject(path);
  const key =
    profileName === "default"
      ? "@llblab/pi-telegram"
      : `@llblab/pi-telegram:${profileName}`;
  const value = locks?.[key];
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
): boolean {
  if (!lock) return true;
  if (
    lock.heartbeatMs !== undefined &&
    nowMs - lock.heartbeatMs > TELEGRAM_LOCK_STALE_HEARTBEAT_MS
  ) {
    return true;
  }
  if (lock.pid === currentPid) return false;
  return !isAlive(lock.pid);
}
