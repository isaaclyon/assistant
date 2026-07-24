import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { loadCapabilityProfile } from "./capabilities.js";
import {
  hasConfiguredTelegramToken,
  resolveBridgeInstanceConfig,
  type BridgeInstanceConfig,
} from "./config.js";
import {
  validateCredentialEnvironmentFile,
  type CredentialEnvironmentSummary,
} from "./credential-environment.js";
import {
  loadBridgeInstanceManifest,
  type BridgeInstanceManifest,
} from "./instances.js";
import {
  renderInstanceServiceUnits,
  type RenderedInstanceServiceUnit,
} from "./service-unit.js";

export interface PrepareBridgeFleetOptions {
  manifestPath: string;
  resourceRoot: string;
  stateRoot: string;
  configRoot: string;
  agentDir: string;
  releaseSha: string;
  nodePath: string;
}

export interface PreparedBridgeFleet {
  manifest: BridgeInstanceManifest;
  configs: BridgeInstanceConfig[];
  units: RenderedInstanceServiceUnit[];
  credentialSummaries: CredentialEnvironmentSummary[];
}

function pathsOverlap(left: string, right: string): boolean {
  const canonicalLeft = resolve(left);
  const canonicalRight = resolve(right);
  return (
    canonicalLeft === canonicalRight ||
    canonicalLeft.startsWith(`${canonicalRight}${sep}`) ||
    canonicalRight.startsWith(`${canonicalLeft}${sep}`)
  );
}

async function canonicalizeExistingOrLexical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function validateFleetTopology(
  configs: readonly BridgeInstanceConfig[],
  options: PrepareBridgeFleetOptions,
): Promise<void> {
  const coordinatorCount = configs.filter(
    (config) => config.jobsRole === "coordinator",
  ).length;
  if (coordinatorCount !== 1) {
    throw new Error(
      `Installable bridge fleet requires exactly one jobs coordinator; found ${coordinatorCount}`,
    );
  }

  const prohibitedWorkspaceRoots = await Promise.all(
    ([
      ["immutable resource root", options.resourceRoot],
      ["state root", options.stateRoot],
      ["configuration root", options.configRoot],
      ["Pi agent directory", options.agentDir],
    ] as const).map(async ([label, path]) => [
      label,
      await canonicalizeExistingOrLexical(path),
    ] as const),
  );
  const canonicalWorkspaces = new Map<string, string>();
  for (const config of configs) {
    let metadata;
    try {
      metadata = await stat(config.workspaceCwd);
    } catch {
      throw new Error(
        `Fleet instance ${config.instanceId} workspace must be an existing directory`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `Fleet instance ${config.instanceId} workspace must be an existing directory`,
      );
    }
    const canonicalWorkspace = await realpath(config.workspaceCwd);
    const existing = canonicalWorkspaces.get(canonicalWorkspace);
    if (existing) {
      throw new Error(
        `Fleet canonical workspace collision between ${existing} and ${config.instanceId}`,
      );
    }
    canonicalWorkspaces.set(canonicalWorkspace, config.instanceId);
    for (const [label, root] of prohibitedWorkspaceRoots) {
      if (pathsOverlap(canonicalWorkspace, root)) {
        throw new Error(
          `Fleet instance ${config.instanceId} workspace overlaps prohibited ${label}`,
        );
      }
    }
  }

  const endpoints = new Map<string, string>();
  for (const config of configs) {
    if (config.webhookPort === 0) continue;
    const endpoint = `${config.webhookHost}:${config.webhookPort}`;
    const existing = endpoints.get(endpoint);
    if (existing) {
      throw new Error(
        `Fleet instances ${existing} and ${config.instanceId} have duplicate webhook endpoint ${endpoint}`,
      );
    }
    endpoints.set(endpoint, config.instanceId);
  }
}

export async function prepareBridgeFleet(
  options: PrepareBridgeFleetOptions,
): Promise<PreparedBridgeFleet> {
  const manifest = await loadBridgeInstanceManifest(options.manifestPath);
  const telegramConfigPath = join(options.agentDir, "telegram.json");
  const configs: BridgeInstanceConfig[] = [];
  const credentialSummaries: CredentialEnvironmentSummary[] = [];

  for (const instance of manifest.instances) {
    await loadCapabilityProfile(options.resourceRoot, instance.capabilityProfile);
    const environmentFilePath = join(
      options.configRoot,
      "instances",
      `${instance.id}.env`,
    );
    const credentialSummary = await validateCredentialEnvironmentFile(
      environmentFilePath,
      instance.credentialScope,
    );
    if (!(await hasConfiguredTelegramToken(telegramConfigPath, instance.telegramProfile))) {
      throw new Error(
        `Telegram profile is not configured for bridge instance ${instance.id}`,
      );
    }
    configs.push(
      resolveBridgeInstanceConfig(
        manifest,
        instance.id,
        {
          PI_CODING_AGENT_DIR: options.agentDir,
          PI_TELEGRAM_BRIDGE_RESOURCE_ROOT: options.resourceRoot,
          PI_TELEGRAM_BRIDGE_STATE_ROOT: options.stateRoot,
          PI_TELEGRAM_BRIDGE_CONFIG_ROOT: options.configRoot,
          ...(credentialSummary.webhookHost
            ? { PI_TELEGRAM_BRIDGE_WEBHOOK_HOST: credentialSummary.webhookHost }
            : {}),
          ...(credentialSummary.webhookPort === undefined
            ? {}
            : {
                PI_TELEGRAM_BRIDGE_WEBHOOK_PORT: String(
                  credentialSummary.webhookPort,
                ),
              }),
          ...(credentialSummary.sessionIdleHours === undefined
            ? {}
            : {
                PI_TELEGRAM_SESSION_IDLE_HOURS: String(
                  credentialSummary.sessionIdleHours,
                ),
              }),
        },
        options.configRoot,
        options.resourceRoot,
      ),
    );
    credentialSummaries.push(credentialSummary);
  }

  await validateFleetTopology(configs, options);

  const units = renderInstanceServiceUnits({
    configs,
    manifestPath: options.manifestPath,
    nodePath: options.nodePath,
    projectDir: options.resourceRoot,
    releaseSha: options.releaseSha,
  });
  return { manifest, configs, units, credentialSummaries };
}
