import { dirname, join } from "node:path";

import type { BridgeConfig, BridgeInstanceConfig } from "./config.js";

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeUnitPath(value: string): string {
  return value.replaceAll("\\", "\\x5c").replaceAll(" ", "\\x20");
}

export interface ServiceUnitOptions {
  config: BridgeConfig;
  environmentFilePath: string;
  nodePath: string;
  projectDir: string;
}

export function renderServiceUnit({
  config,
  environmentFilePath,
  nodePath,
  projectDir,
}: ServiceUnitOptions): string {
  const executable = join(projectDir, "dist", "src", "daemon.js");
  const path = [
    dirname(nodePath),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");

  return `[Unit]\nDescription=Persistent Pi Telegram bridge\nDocumentation=https://github.com/llblab/pi-telegram\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitPath(config.cwd)}\nExecStart=${quote(nodePath)} ${quote(executable)}\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=30s\nUMask=0077\nEnvironment=${quote(`PATH=${path}`)}\nEnvironment=${quote(`PI_CODING_AGENT_DIR=${config.agentDir}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_CWD=${config.cwd}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_STATE_DIR=${config.stateDir}`)}\nEnvironment=${quote(`PI_TELEGRAM_CODEX_CONFIG=${config.codexConfigPath}`)}\nEnvironmentFile=-${quote(environmentFilePath)}\n\n[Install]\nWantedBy=default.target\n`;
}

export interface InstanceServiceUnitOptions {
  config: BridgeInstanceConfig;
  manifestPath: string;
  nodePath: string;
  projectDir: string;
  releaseSha: string;
}

export interface RenderedInstanceServiceUnit {
  unitName: string;
  contents: string;
}

export function renderInstanceServiceUnit({
  config,
  manifestPath,
  nodePath,
  projectDir,
  releaseSha,
}: InstanceServiceUnitOptions): RenderedInstanceServiceUnit {
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
    throw new Error("Instance service unit requires a full release SHA");
  }
  const executable = join(projectDir, "dist", "src", "daemon.js");
  const path = [
    dirname(nodePath),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
  const unitName = `pi-telegram-bridge-${config.instanceId}.service`;
  const contents = `[Unit]\nDescription=Persistent Pi Telegram bridge (${config.displayName} / ${config.instanceId})\nDocumentation=https://github.com/llblab/pi-telegram\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitPath(config.resourceRoot)}\nExecStart=${quote(nodePath)} ${quote(executable)}\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=30s\nUMask=0077\nEnvironment=${quote(`PATH=${path}`)}\nEnvironment=${quote(`PI_CODING_AGENT_DIR=${config.agentDir}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST=${manifestPath}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_INSTANCE_ID=${config.instanceId}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_RESOURCE_ROOT=${config.resourceRoot}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_RELEASE_SHA=${releaseSha}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_STATE_ROOT=${config.stateRoot}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_CONFIG_ROOT=${config.configRoot}`)}\nEnvironmentFile=-${quote(config.environmentFilePath)}\n\n[Install]\nWantedBy=default.target\n`;
  return { unitName, contents };
}

export interface InstanceServiceUnitsOptions
  extends Omit<InstanceServiceUnitOptions, "config"> {
  configs: readonly BridgeInstanceConfig[];
}

function assertUniqueConfigField(
  configs: readonly BridgeInstanceConfig[],
  label: string,
  select: (config: BridgeInstanceConfig) => string,
): void {
  const values = new Set<string>();
  for (const config of configs) {
    const value = select(config);
    if (values.has(value)) {
      throw new Error(`Fleet service units have duplicate ${label}: ${value}`);
    }
    values.add(value);
  }
}

export function renderInstanceServiceUnits({
  configs,
  ...options
}: InstanceServiceUnitsOptions): RenderedInstanceServiceUnit[] {
  if (configs.length === 0) {
    throw new Error("Fleet service unit rendering requires configured instances");
  }
  assertUniqueConfigField(configs, "instance ID", (config) => config.instanceId);
  assertUniqueConfigField(configs, "Telegram profile", (config) => config.telegramProfile);
  assertUniqueConfigField(configs, "workspace", (config) => config.workspaceCwd);
  assertUniqueConfigField(configs, "state directory", (config) => config.stateDir);
  assertUniqueConfigField(configs, "session directory", (config) => config.sessionDir);
  assertUniqueConfigField(configs, "inbox", (config) => config.inboxPath);
  assertUniqueConfigField(
    configs,
    "environment file",
    (config) => config.environmentFilePath,
  );
  if (configs.filter((config) => config.jobsRole === "coordinator").length > 1) {
    throw new Error("Fleet service units require at most one jobs coordinator");
  }
  for (const config of configs) {
    if (config.resourceRoot !== options.projectDir) {
      throw new Error(
        `Fleet instance ${config.instanceId} does not reference the shared immutable release`,
      );
    }
  }
  return configs.map((config) => renderInstanceServiceUnit({ config, ...options }));
}
