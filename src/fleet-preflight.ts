import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { prepareBridgeFleet } from "./fleet-config.js";

const home = homedir();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for fleet preflight`);
  return value;
}

function resolveFromHome(value: string, label: string): string {
  const resolved = isAbsolute(value) ? resolve(value) : resolve(home, value);
  if (!isAbsolute(resolved)) throw new Error(`${label} must resolve absolutely`);
  return resolved;
}

const configRoot = resolveFromHome(
  process.env.PI_TELEGRAM_BRIDGE_CONFIG_ROOT?.trim() ||
    join(home, ".config", "pi-telegram-bridge"),
  "config root",
);
const stateRoot = resolveFromHome(
  process.env.PI_TELEGRAM_BRIDGE_STATE_ROOT?.trim() ||
    join(home, ".local", "state", "pi-telegram-bridge"),
  "state root",
);
const resourceRoot = resolveFromHome(
  required("PI_TELEGRAM_BRIDGE_RESOURCE_ROOT"),
  "resource root",
);
const manifestPath = resolveFromHome(
  process.env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST?.trim() ||
    join(configRoot, "instances.json"),
  "instance manifest",
);
const fleet = await prepareBridgeFleet({
  manifestPath,
  resourceRoot,
  stateRoot,
  configRoot,
  agentDir: resolveFromHome(
    process.env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent"),
    "agent directory",
  ),
  releaseSha: required("PI_TELEGRAM_BRIDGE_RELEASE_SHA"),
  nodePath: process.execPath,
});

console.log(
  JSON.stringify({
    version: 1,
    instanceIds: fleet.configs.map((config) => config.instanceId),
    coordinatorId: fleet.configs.find(
      (config) => config.jobsRole === "coordinator",
    )?.instanceId,
  }),
);
