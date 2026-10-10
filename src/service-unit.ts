import { dirname, isAbsolute, join, normalize, sep } from "node:path";

import type { BridgeInstanceConfig } from "./config.js";
import { privateBrowserEndpoint } from "./private-browser-endpoint.js";

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeUnitPath(value: string): string {
  return value.replaceAll("\\", "\\x5c").replaceAll(" ", "\\x20");
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
  const contents = `[Unit]\nDescription=Persistent Pi Telegram bridge (${config.displayName} / ${config.instanceId})\nDocumentation=https://github.com/llblab/pi-telegram\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitPath(config.resourceRoot)}\nExecCondition=${quote(nodePath)} ${quote(join(projectDir, "dist", "src", "recovery-start-check.js"))} ${quote(config.stateRoot)}\nExecStart=${quote(nodePath)} ${quote(executable)}\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=30s\nUMask=0077\nEnvironment=${quote(`PATH=${path}`)}\nEnvironment=${quote(`PI_CODING_AGENT_DIR=${config.agentDir}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST=${manifestPath}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_INSTANCE_ID=${config.instanceId}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_RESOURCE_ROOT=${config.resourceRoot}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_RELEASE_SHA=${releaseSha}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_STATE_ROOT=${config.stateRoot}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_CONFIG_ROOT=${config.configRoot}`)}\nEnvironmentFile=-${escapeUnitPath(config.environmentFilePath)}\n\n[Install]\nWantedBy=default.target\n`;
  return { unitName, contents };
}

export interface InstanceServiceUnitsOptions
  extends Omit<InstanceServiceUnitOptions, "config"> {
  configs: readonly BridgeInstanceConfig[];
}

export interface IsolatedInstanceServiceUnitOptions extends InstanceServiceUnitOptions {
  user: string;
  group: string;
  privateHome: string;
  networkNamespace: string;
  resolverPath: string;
  auditPolicyPath: string;
  trustedSocket: string;
  browserAddress: string;
  privateInputOrigin: string;
  privateTakeoverOrigin: string;
}

/** Render only: account membership, canonical ownership and transport preflight
 * must succeed before an administrator installs this system unit. */
export function renderIsolatedInstanceServiceUnit(
  options: IsolatedInstanceServiceUnitOptions,
): RenderedInstanceServiceUnit {
  for (const account of [options.user, options.group]) {
    if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(account) ||
        ["root", "sudo", "wheel", "docker", "lxd", "adm"].includes(account)) {
      throw new Error("Isolated service requires an unprivileged named account");
    }
  }
  const { privateHome, config } = options;
  if (!/^pi-[a-z0-9-]{1,24}$/.test(options.networkNamespace) ||
      !/^\/run\/[a-z0-9/-]+\.sock$/.test(options.trustedSocket)) throw new Error("Invalid isolated service transport");
  const endpointEnv = { PI_TELEGRAM_TRUSTED_SOCKET: options.trustedSocket,
    PI_PRIVATE_BROWSER_BIND_ADDRESS: options.browserAddress, PI_PRIVATE_INPUT_ORIGIN: options.privateInputOrigin,
    PI_PRIVATE_TAKEOVER_ORIGIN: options.privateTakeoverOrigin };
  privateBrowserEndpoint("input", endpointEnv);
  if (!/^\/var\/lib\/[a-z][a-z0-9_-]*$/.test(privateHome)) {
    throw new Error("Isolated service requires a dedicated private home under /var/lib");
  }
  const insideHome = (path: string) => path === privateHome || path.startsWith(`${privateHome}${sep}`);
  const mutable = [config.agentDir, config.stateRoot, config.stateDir, config.sessionDir, config.workspaceCwd];
  const immutable = [options.manifestPath, options.nodePath, options.projectDir, config.resourceRoot,
    config.configRoot, config.environmentFilePath, options.resolverPath, options.auditPolicyPath];
  for (const path of [...mutable, ...immutable]) {
    if (!isAbsolute(path) || normalize(path) !== path || /[\r\n\0%]/.test(path)) {
      throw new Error("Isolated service paths must be normalized absolute paths without unit specifiers");
    }
  }
  if (mutable.some(path => !insideHome(path))) {
    throw new Error("Personal mutable paths must be inside the private home");
  }
  if (immutable.some(path => insideHome(path) || privateHome.startsWith(`${path}${sep}`) ||
      path === "/" || path.startsWith("/home/") || path.startsWith("/root/"))) {
    throw new Error("Service code and configuration must be outside writable or hidden homes");
  }
  const rendered = renderInstanceServiceUnit(options);
  const restrictions = [
    `User=${options.user}`, `Group=${options.group}`, "SupplementaryGroups=",
    "NoNewPrivileges=yes", "CapabilityBoundingSet=", "AmbientCapabilities=",
    "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes",
    "RestrictSUIDSGID=yes", "ProtectKernelTunables=yes", "ProtectKernelModules=yes",
    "ProtectControlGroups=yes", "RestrictRealtime=yes", "LockPersonality=yes",
    "ProtectProc=invisible",
    "PassEnvironment=PI_TELEGRAM_RECOVERY_AUTHORIZATION",
    `ExecStartPre=${quote(options.nodePath)} ${quote(join(options.projectDir, "dist/src/isolation-start-check.js"))} ${quote(options.auditPolicyPath)} ${options.networkNamespace}`,
    `NetworkNamespacePath=/run/netns/${options.networkNamespace}`,
    `BindReadOnlyPaths=${quote(options.resolverPath)}:/etc/resolv.conf`,
    ...Object.entries(endpointEnv).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`),
    `ReadWritePaths=${quote(privateHome)}`, `Environment=${quote(`HOME=${privateHome}`)}`,
  ].join("\n");
  return {
    ...rendered,
    contents: rendered.contents.replace("[Unit]\n", `[Unit]\nRequires=pi-isolated-network-${options.networkNamespace}.service pi-trusted-broker-${config.instanceId}.service\nAfter=pi-isolated-network-${options.networkNamespace}.service pi-trusted-broker-${config.instanceId}.service\n`)
      .replace("[Service]\n", `[Service]\n${restrictions}\n`)
      .replace("WantedBy=default.target", "WantedBy=multi-user.target"),
  };
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
