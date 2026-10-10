import { readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { assertAdministratorPath } from "./isolation-admin-path.js";
import { privateBrowserEndpoint } from "./private-browser-endpoint.js";
import { validateIsolationNetwork, type IsolationNetworkConfig } from "./isolation-network.js";

export interface ManagedRuntime {
  instanceId: string;
  user: string;
  uid: number;
  gid: number;
  home: string;
  manager: "user" | "system";
  manifestPath: string;
  configRoot: string;
  stateRoot: string;
  agentDir: string;
}
export interface IsolatedDeploymentConfig {
  version: 1;
  nodePath: string;
  releaseRoot: string;
  checkpointRoot: string;
  runtimes: ManagedRuntime[];
  broker: { user: string; uid: number; gid: number; home: string; configPath: string; stateDir: string };
  network: IsolationNetworkConfig;
  networkConfigPath: string;
  endpointConfigPath: string;
  resolverPath: string;
  privateInputOrigin: string;
  privateTakeoverOrigin: string;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const path = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && normalize(value) === value && value !== "/" && !/[\s\0%$"\\]/.test(value);
const identity = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const account = (value: unknown): value is string => typeof value === "string" && /^[a-z_][a-z0-9_-]{0,30}$/.test(value) && !["root", "sudo", "docker", "lxd", "wheel", "adm"].includes(value);
const inside = (child: string, parent: string) => child.startsWith(`${parent}/`);

/** Deployment routing is administrator-owned and deliberately separate from
 * the runtime manifest. A runtime cannot select its UID, manager or broker. */
export function parseIsolatedDeploymentConfig(value: unknown): IsolatedDeploymentConfig {
  if (!record(value) || !keys(value, ["version", "nodePath", "releaseRoot", "checkpointRoot", "runtimes", "broker", "network", "networkConfigPath", "endpointConfigPath", "resolverPath", "privateInputOrigin", "privateTakeoverOrigin"]) ||
      value.version !== 1 || !Array.isArray(value.runtimes) || value.runtimes.length < 1 || value.runtimes.length > 8 ||
      ![value.nodePath, value.releaseRoot, value.checkpointRoot, value.networkConfigPath, value.endpointConfigPath, value.resolverPath].every(path) ||
      !String(value.nodePath).startsWith("/opt/") || !String(value.releaseRoot).startsWith("/opt/") || !String(value.checkpointRoot).startsWith("/var/lib/") ||
      !record(value.broker) || !keys(value.broker, ["user", "uid", "gid", "home", "configPath", "stateDir"]) ||
      !account(value.broker.user) || !identity(value.broker.uid) || !identity(value.broker.gid) ||
      !path(value.broker.home) || !/^\/var\/lib\/[a-z][a-z0-9_-]*$/.test(value.broker.home) ||
      !path(value.broker.configPath) || !path(value.broker.stateDir) || !inside(value.broker.stateDir, value.broker.home) ||
      inside(value.broker.configPath, value.broker.stateDir)) throw new Error("Invalid isolated deployment configuration");
  const ids = new Set<string>(), uids = new Set<number>(), roots: string[] = [];
  for (const runtime of value.runtimes) {
    if (!record(runtime) || !keys(runtime, ["instanceId", "user", "uid", "gid", "home", "manager", "manifestPath", "configRoot", "stateRoot", "agentDir"]) ||
        typeof runtime.instanceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runtime.instanceId) || ids.has(runtime.instanceId) ||
        !account(runtime.user) || !identity(runtime.uid) || runtime.uid === value.broker.uid || uids.has(runtime.uid) || !identity(runtime.gid) ||
        !["user", "system"].includes(String(runtime.manager)) ||
        ![runtime.home, runtime.manifestPath, runtime.configRoot, runtime.stateRoot, runtime.agentDir].every(path)) throw new Error("Invalid deployment runtime");
    if (runtime.manager === "system" && (!/^\/var\/lib\/[a-z][a-z0-9_-]*$/.test(String(runtime.home)) ||
        !inside(String(runtime.stateRoot), String(runtime.home)) || !inside(String(runtime.agentDir), String(runtime.home)) ||
        inside(String(runtime.configRoot), String(runtime.home)))) throw new Error("Invalid isolated runtime roots");
    ids.add(runtime.instanceId); uids.add(runtime.uid); roots.push(String(runtime.stateRoot));
  }
  if (value.runtimes.filter(runtime => runtime.manager === "system").length !== 1) throw new Error("Deployment requires exactly one isolated personal runtime");
  roots.push(String(value.checkpointRoot), value.broker.stateDir, String(value.releaseRoot));
  if (roots.some((root, i) => roots.slice(i + 1).some(other => root === other || inside(root, other) || inside(other, root)))) throw new Error("Deployment roots overlap");
  validateIsolationNetwork(value.network as IsolationNetworkConfig);
  privateBrowserEndpoint("input", { PI_PRIVATE_BROWSER_BIND_ADDRESS: (value.network as IsolationNetworkConfig).runtimeAddress,
    PI_PRIVATE_INPUT_ORIGIN: String(value.privateInputOrigin), PI_PRIVATE_TAKEOVER_ORIGIN: String(value.privateTakeoverOrigin) });
  return value as unknown as IsolatedDeploymentConfig;
}

export async function loadIsolatedDeploymentConfig(filename: string): Promise<IsolatedDeploymentConfig> {
  await assertAdministratorPath(filename);
  return parseIsolatedDeploymentConfig(JSON.parse(await readFile(filename, "utf8")));
}
