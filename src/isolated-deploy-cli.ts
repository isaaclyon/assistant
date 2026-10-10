import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chown, cp, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";
import { loadCapabilityProfile } from "./capabilities.js";
import { resolveBridgeInstanceConfig, type BridgeInstanceConfig } from "./config.js";
import { validateCredentialEnvironmentFile } from "./credential-environment.js";
import { assertAdministratorPath } from "./isolation-admin-path.js";
import { evaluateIsolationIdentity, parseLinuxProcessStatus } from "./isolation-audit.js";
import { renderIsolationSupportUnits } from "./isolation-support-units.js";
import { activateIsolatedDeployment } from "./isolated-deployment.js";
import { applyIsolatedMigration, inventoryIsolatedMigration, type IsolatedMigrationPlan } from "./isolated-migration.js";
import { migrateTelegramOwnership, splitTelegramOwnership } from "./isolated-telegram-migration.js";
import { loadIsolatedDeploymentConfig, type ManagedRuntime } from "./isolated-deployment-config.js";
import { captureIsolatedRecovery, markIsolatedRecoveryStarted, setTreeOwnership, writeDurableExclusive, type IsolatedRecoverySource } from "./isolated-recovery.js";
import { assertConfiguredBridgeUnits, assertServiceQuiescent, controlService, systemManager, type ManagedService } from "./isolated-service-control.js";
import { loadBridgeInstanceManifest } from "./instances.js";
import { loadValidatedJobs } from "./jobs-validation.js";
import { digestTree } from "./recovery-snapshot.js";
import { assertRuntimeReady, readRuntimeMetadata } from "./runtime-metadata.js";
import { renderInstanceServiceUnit, renderIsolatedInstanceServiceUnit, type RenderedInstanceServiceUnit } from "./service-unit.js";
import { parseTrustedBrokerConfig } from "./trusted-broker-config.js";
import { trustedTelegramFetch } from "./trusted-telegram-ipc.js";

const [sha, sourceRelease, action = "activate", configPath = "/etc/pi-telegram-bridge/isolated-deployment.json", migrationPath] = process.argv.slice(2);
if (process.getuid?.() !== 0 || process.platform !== "linux" || !sha || !/^[a-f0-9]{40}$/.test(sha) ||
    !sourceRelease || !["inventory", "preflight", "activate"].includes(action) || process.argv.length > 7) throw new Error("Isolated deployment requires root, full release SHA and a built release");
process.umask(0o077);
const policy = await loadIsolatedDeploymentConfig(configPath);
let migration: IsolatedMigrationPlan | undefined;
if (migrationPath) {
  await assertAdministratorPath(migrationPath);
  migration = JSON.parse(await readFile(migrationPath, "utf8"));
}
await assertAdministratorPath(policy.nodePath);
const release = join(policy.releaseRoot, sha);
const personal = policy.runtimes.find(runtime => runtime.manager === "system")!;
const socketPath = `/run/pi-broker-${personal.instanceId}/telegram.sock`;
const support = renderIsolationSupportUnits({ instanceId: personal.instanceId, nodePath: policy.nodePath, releasePath: release,
  namespace: policy.network.namespace, networkConfigPath: policy.networkConfigPath, endpointConfigPath: policy.endpointConfigPath,
  brokerConfigPath: policy.broker.configPath, brokerHome: policy.broker.home, brokerUser: policy.broker.user, runtimeGroup: personal.user });
const services: ManagedService[] = [];
const candidates: Array<{ runtime: ManagedRuntime; config: BridgeInstanceConfig; unit: RenderedInstanceServiceUnit; service: ManagedService }> = [];
const userManagers = policy.runtimes.filter(runtime => runtime.manager === "user");
const uniqueManagers = [systemManager, ...userManagers];
const holds = [...policy.runtimes.map(runtime => ({ path: join(runtime.stateRoot, ".recovery-maintenance"), uid: runtime.uid, gid: runtime.gid })),
  { path: join(policy.broker.home, ".recovery-maintenance"), uid: policy.broker.uid, gid: policy.broker.gid }];
const snapshot = join(policy.checkpointRoot, `checkpoint-${randomUUID()}`), authorization = randomUUID();
const exec = promisify(execFile);
const interrupted = new AbortController();
const interrupt = () => interrupted.abort();
process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function durableRemove(path: string): Promise<void> {
  await rm(path);
  const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function writeUnit(service: ManagedService, contents: string): Promise<void> {
  const temporary = `${service.path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
  if (service.manager.manager === "user") {
    const owner = userManagers.find(runtime => runtime.uid === service.manager.uid)!;
    await chown(temporary, owner.uid, owner.gid);
  }
  await rename(temporary, service.path);
  const directory = await open(dirname(service.path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function stopAll(): Promise<void> {
  let failed = false;
  for (const service of [...services].reverse()) {
    if (!await exists(service.path)) continue;
    try { await controlService(service.manager, "disable", "--now", service.name); } catch { failed = true; }
  }
  if (failed) throw new Error("Could not stop every managed writer");
}
async function quiescent(): Promise<void> {
  for (const service of services) if (await exists(service.path)) await assertServiceQuiescent(service);
}
async function preflight(): Promise<void> {
  if (migration) console.log(JSON.stringify({ migrationInventory: await inventoryIsolatedMigration(migration) }));
  for (const marker of holds) if (await exists(marker.path)) throw new Error("Unresolved recovery hold blocks deployment");
  for (const runtime of [...policy.runtimes, policy.broker]) {
    const actual = (await exec("/usr/bin/id", [runtime.user], { timeout: 5_000 })).stdout;
    const uid = Number((await exec("/usr/bin/id", ["-u", runtime.user], { timeout: 5_000 })).stdout.trim());
    const gid = Number((await exec("/usr/bin/id", ["-g", runtime.user], { timeout: 5_000 })).stdout.trim());
    if (uid !== runtime.uid || gid !== runtime.gid || ((runtime === personal || runtime === policy.broker) && /\b(?:sudo|docker|lxd|adm|wheel)\b/.test(actual))) throw new Error("Service account identity is not isolated");
  }
  for (const path of [policy.releaseRoot, policy.checkpointRoot, personal.configRoot, policy.networkConfigPath, policy.endpointConfigPath, policy.resolverPath]) await assertAdministratorPath(path);
  if (JSON.stringify(JSON.parse(await readFile(policy.networkConfigPath, "utf8"))) !== JSON.stringify(policy.network)) throw new Error("Network configuration differs from deployment policy");
  const endpoint = JSON.parse(await readFile(policy.endpointConfigPath, "utf8"));
  if (endpoint.PI_PRIVATE_BROWSER_BIND_ADDRESS !== policy.network.runtimeAddress || endpoint.PI_PRIVATE_INPUT_ORIGIN !== policy.privateInputOrigin ||
      endpoint.PI_PRIVATE_TAKEOVER_ORIGIN !== policy.privateTakeoverOrigin) throw new Error("Private endpoint configuration differs from deployment policy");
  const broker = parseTrustedBrokerConfig(JSON.parse(await readFile(policy.broker.configPath, "utf8")));
  if (migration?.telegram) {
    const source = migration.telegram;
    const metadata = await lstat(source.sourcePath);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== source.sourceUid || (metadata.mode & 0o777) !== 0o600 ||
        await realpath(source.sourcePath) !== source.sourcePath) throw new Error("Unsafe selected Telegram migration source");
    splitTelegramOwnership(JSON.parse(await readFile(source.sourcePath, "utf8")), source.profile, broker);
  }
  if (broker.instance !== personal.instanceId || broker.socketPath !== socketPath || broker.databasePath !== join(policy.broker.stateDir, "telegram.db") ||
      broker.vault.home !== policy.broker.home) throw new Error("Broker configuration differs from deployment policy");
  await assertAdministratorPath(broker.vault.binary);
  for (const path of [policy.broker.configPath, broker.vault.tokenFile]) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== policy.broker.uid || (metadata.mode & 0o777) !== 0o600 || await realpath(path) !== path) throw new Error("Broker credentials have unsafe ownership");
  }
  // Source is produced by the already-authorized administrative deployer. Verify
  // a self-contained release before copying it into immutable root ownership.
  if (await realpath(sourceRelease!) !== sourceRelease) throw new Error("Noncanonical candidate release");
  const sourceUid = (await lstat(sourceRelease!)).uid;
  const sourceDigest = await digestTree(sourceRelease!, true, false, undefined, sourceUid);
  if (!await exists(release)) {
    const staging = `${release}.staging-${randomUUID()}`;
    await cp(sourceRelease!, staging, { recursive: true, verbatimSymlinks: true });
    await setTreeOwnership(staging, 0, 0);
    if (await digestTree(staging, true, true) !== sourceDigest) throw new Error("Candidate release copy verification failed");
    await rename(staging, release);
  }
  await assertAdministratorPath(release);
  if (await digestTree(release, true) !== sourceDigest) throw new Error("Existing immutable release differs from candidate");
  for (const runtime of policy.runtimes) {
    const manifest = await loadBridgeInstanceManifest(runtime.manifestPath);
    if (runtime === personal && (manifest.instances.length !== 1 || manifest.instances[0]?.id !== runtime.instanceId)) throw new Error("Personal runtime must have a self-only manifest");
    const env = { PI_CODING_AGENT_DIR: runtime.agentDir, PI_TELEGRAM_BRIDGE_STATE_ROOT: runtime.stateRoot,
      PI_TELEGRAM_BRIDGE_CONFIG_ROOT: runtime.configRoot, PI_TELEGRAM_BRIDGE_RESOURCE_ROOT: release };
    const config = resolveBridgeInstanceConfig(manifest, runtime.instanceId, env, runtime.home, release);
    await validateCredentialEnvironmentFile(config.environmentFilePath, config.credentialScope, runtime.uid);
    await loadCapabilityProfile(release, config.capabilityProfile);
    if (runtime === personal) {
      if (migration?.telegram && migration.telegram.profile !== config.telegramProfile) throw new Error("Telegram migration profile does not match the selected personal runtime");
      if (config.telegramSurface.type !== "private" || config.jobsRole !== "coordinator") throw new Error("Isolated personal runtime must own its private jobs");
      await loadValidatedJobs({ stateDir: config.stateDir, configuredInstanceIds: [runtime.instanceId] });
      if (!migration && !await exists(join(config.stateDir, "job-occurrences.db"))) throw new Error("Initialize legacy job recovery before isolation migration");
    }
    const shared = { config, manifestPath: runtime.manifestPath, nodePath: policy.nodePath, projectDir: release, releaseSha: sha! };
    const unit = runtime === personal ? renderIsolatedInstanceServiceUnit({ ...shared, user: runtime.user, group: runtime.user, privateHome: runtime.home,
      networkNamespace: policy.network.namespace, resolverPath: policy.resolverPath, auditPolicyPath: join(runtime.configRoot, "isolation-policy.json"),
      trustedSocket: socketPath, browserAddress: policy.network.runtimeAddress, privateInputOrigin: policy.privateInputOrigin, privateTakeoverOrigin: policy.privateTakeoverOrigin }) : renderInstanceServiceUnit(shared);
    const service: ManagedService = { name: unit.unitName, manager: runtime, path: join(runtime.manager === "system" ? "/etc/systemd/system" : join(runtime.home, ".config/systemd/user"), unit.unitName) };
    services.push(service); candidates.push({ runtime, config, unit, service });
  }
  for (const unit of support) services.push({ name: unit.unitName, manager: systemManager, path: join("/etc/systemd/system", unit.unitName) });
  // Keep the former user unit in the transition and permanently mask it. It may
  // never be recreated by the standard installer after a successful cutover.
  for (const manager of userManagers) {
    const name = `pi-telegram-bridge-${personal.instanceId}.service`;
    services.push({ name, manager, path: join(manager.home, ".config/systemd/user", name) });
  }
  await assertConfiguredBridgeUnits(services, uniqueManagers);
  console.log("Isolated fleet preflight passed.");
}

await mkdir(policy.checkpointRoot, { recursive: true, mode: 0o700 });
await assertAdministratorPath(policy.checkpointRoot);
await withMutationLock(join(policy.checkpointRoot, "deployment-lock.sqlite"), async () => {
  if (action === "inventory") {
    if (!migration) throw new Error("Inventory requires a selected migration plan");
    console.log(JSON.stringify({ migrationInventory: await inventoryIsolatedMigration(migration) }));
    return;
  }
  if (action === "preflight") { await preflight(); return; }
  await activateIsolatedDeployment({ preflight,
    hold: async () => {
      for (const marker of holds) {
        await writeDurableExclusive(marker.path, { version: 1, authorization, snapshotDir: snapshot });
        await chown(marker.path, marker.uid, marker.gid);
      }
    }, stopAll, assertQuiescent: quiescent,
    checkpoint: async () => {
      const sources: IsolatedRecoverySource[] = policy.runtimes.map(runtime => ({ role: `${runtime.instanceId}-state`, path: runtime.stateRoot, uid: runtime.uid, gid: runtime.gid, kind: "state" }));
      sources.push({ role: "broker-state", path: policy.broker.stateDir, uid: policy.broker.uid, gid: policy.broker.gid, kind: "state" });
      const priorReleases = new Set<string>();
      for (const [index, service] of services.entries()) {
        if (!await exists(service.path)) continue;
        const metadata = await lstat(service.path);
        if (metadata.isSymbolicLink() && await readlink(service.path) === "/dev/null") continue;
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64_000) throw new Error("Unsafe prior service unit");
        sources.push({ role: `unit-${index}`, path: service.path, uid: metadata.uid, gid: metadata.gid, kind: "unit" });
        const raw = await readFile(service.path, "utf8");
        for (const match of raw.matchAll(/^ExecStart="[^"]+" "([^"]+\/dist\/src\/(?:daemon|trusted-broker-daemon)\.js)"/gm)) {
          priorReleases.add(dirname(dirname(dirname(match[1]!))));
        }
      }
      for (const [index, path] of [...priorReleases].entries()) {
        if (!/\/[a-f0-9]{40}$/.test(path)) throw new Error("Previous application is not an immutable release");
        const metadata = await lstat(path);
        sources.push({ role: `release-${index}`, path, uid: metadata.uid, gid: metadata.gid, kind: "release" });
      }
      const configSources = [configPath, personal.configRoot, policy.broker.configPath, policy.networkConfigPath, policy.endpointConfigPath, policy.resolverPath,
        ...candidates.flatMap(candidate => [candidate.runtime.manifestPath, candidate.config.environmentFilePath])];
      for (const [index, path] of configSources.entries()) {
        if (sources.some(source => path === source.path || path.startsWith(`${source.path}/`))) continue;
        const metadata = await lstat(path);
        sources.push({ role: `config-${index}`, path, uid: metadata.uid, gid: metadata.gid, kind: "config" });
      }
      await captureIsolatedRecovery(snapshot, sources);
      console.log("Paired runtime and broker checkpoint verified.");
    },
    migrate: async () => {
      if (!migration) return;
      await applyIsolatedMigration(migration, snapshot, quiescent);
      if (migration.telegram) await migrateTelegramOwnership({ ...migration.telegram,
        runtimePath: join(personal.agentDir, "telegram.json"), runtimeUid: personal.uid, runtimeGid: personal.gid,
        brokerPath: policy.broker.configPath, brokerUid: policy.broker.uid, brokerGid: policy.broker.gid,
      }, snapshot, quiescent);
      for (const candidate of candidates) if (candidate.runtime === personal) {
        await loadValidatedJobs({ stateDir: candidate.config.stateDir, configuredInstanceIds: [personal.instanceId] });
        if (!await exists(join(candidate.config.stateDir, "job-occurrences.db"))) throw new Error("Migrated job recovery ledger is missing");
      }
      console.log("Selected personal migration verified with all writers stopped.");
    },
    install: async () => {
      for (const candidate of candidates) await writeUnit(candidate.service, candidate.unit.contents);
      for (const unit of support) await writeUnit(services.find(service => service.name === unit.unitName)!, unit.contents);
      for (const manager of userManagers) {
        const legacy = services.find(service => service.manager.uid === manager.uid && service.name === `pi-telegram-bridge-${personal.instanceId}.service`)!;
        if (await exists(legacy.path)) await rename(legacy.path, `${legacy.path}.retired-${randomUUID()}`);
        await symlink("/dev/null", legacy.path);
      }
      for (const manager of uniqueManagers) await controlService(manager, "daemon-reload");
    },
    markStarted: () => markIsolatedRecoveryStarted(snapshot),
    authorize: async () => { for (const manager of uniqueManagers) await controlService(manager, "set-environment", `PI_TELEGRAM_RECOVERY_AUTHORIZATION=${authorization}`); },
    start: async () => {
      for (const unit of support) await controlService(systemManager, "start", unit.unitName);
      let connected = false;
      const brokerDeadline = Date.now() + 25_000;
      while (Date.now() < brokerDeadline) {
        try {
          const response = await trustedTelegramFetch(socketPath)("https://api.telegram.org/bot0:runtime/getMe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2_000) });
          if (response.ok) { connected = true; break; }
        } catch { /* bounded initialization wait */ }
        await pause(500);
      }
      if (!connected) throw new Error("Trusted broker did not become ready");
      for (const candidate of candidates) await controlService(candidate.runtime, "start", candidate.unit.unitName);
    },
    ready: async () => {
      for (const unit of support) {
        if (await controlService(systemManager, "show", unit.unitName, "--property=ActiveState", "--value") !== "active") throw new Error("Isolation support service is not active");
      }
      for (const candidate of candidates) {
        let stable = 0, lastPid = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            const pid = Number(await controlService(candidate.runtime, "show", candidate.unit.unitName, "--property=MainPID", "--value"));
            assertRuntimeReady(await readRuntimeMetadata(candidate.config.runtimeMetadataPath), { instanceId: candidate.runtime.instanceId, releaseSha: sha!, pid });
            if (candidate.runtime === personal && evaluateIsolationIdentity(parseLinuxProcessStatus(await readFile(`/proc/${pid}/status`, "utf8")), { uid: personal.uid, gid: personal.gid }).length) throw new Error();
            stable = pid === lastPid ? stable + 1 : 1; lastPid = pid;
            if (stable >= 5) break;
          } catch { stable = 0; lastPid = 0; }
          await pause(1000);
        }
        if (stable < 5) throw new Error("Candidate did not become stable and ready");
      }
      for (const unit of support) {
        if (await controlService(systemManager, "show", unit.unitName, "--property=ActiveState", "--value") !== "active") throw new Error("Isolation support service failed during readiness");
      }
    },
    revoke: async () => {
      const results = await Promise.allSettled(uniqueManagers.map(manager => controlService(manager, "unset-environment", "PI_TELEGRAM_RECOVERY_AUTHORIZATION")));
      if (results.some(result => result.status === "rejected")) throw new Error("Could not revoke every startup authorization");
    },
    enable: async () => {
      for (const candidate of candidates) await controlService(candidate.runtime, "enable", candidate.unit.unitName);
      for (const unit of support) await controlService(systemManager, "enable", unit.unitName);
    },
    complete: async () => { for (const marker of holds) await durableRemove(marker.path); console.log("Isolated fleet activation complete."); },
  }, interrupted.signal);
}, { timeoutMs: 0 });
process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt);
