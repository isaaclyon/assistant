// Installs the initial legacy fleet with the repository's real unit renderers. Imports the compiled
// artifacts mounted at /c6/artifacts. Usage: bootstrap.mjs <oldSha>
import { chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const base = '/c6/artifacts/dist/src';
const { loadIsolatedDeploymentConfig } = await import(`${base}/isolated-deployment-config.js`);
const { loadBridgeInstanceManifest } = await import(`${base}/instances.js`);
const { resolveBridgeInstanceConfig } = await import(`${base}/config.js`);
const { renderInstanceServiceUnit, renderIsolatedInstanceServiceUnit } = await import(`${base}/service-unit.js`);
const { renderIsolationSupportUnits } = await import(`${base}/isolation-support-units.js`);
const sha = process.argv[2];
const policy = await loadIsolatedDeploymentConfig('/etc/c6-live/deploy.json');
const release = join(policy.releaseRoot, sha);
const personal = policy.runtimes.find(r => r.manager === 'system');
const socketPath = `/run/pi-broker-${personal.instanceId}/telegram.sock`;
for (const runtime of policy.runtimes) {
  const manifest = await loadBridgeInstanceManifest(runtime.manifestPath);
  const env = { PI_CODING_AGENT_DIR: runtime.agentDir, PI_TELEGRAM_BRIDGE_STATE_ROOT: runtime.stateRoot, PI_TELEGRAM_BRIDGE_CONFIG_ROOT: runtime.configRoot, PI_TELEGRAM_BRIDGE_RESOURCE_ROOT: release };
  const config = resolveBridgeInstanceConfig(manifest, runtime.instanceId, env, runtime.home, release);
  const shared = { config, manifestPath: runtime.manifestPath, nodePath: policy.nodePath, projectDir: release, releaseSha: sha };
  const unit = runtime === personal ? renderIsolatedInstanceServiceUnit({ ...shared, user: runtime.user, group: runtime.user, privateHome: runtime.home, networkNamespace: policy.network.namespace,
    resolverPath: policy.resolverPath, auditPolicyPath: join(runtime.configRoot, 'isolation-policy.json'), trustedSocket: socketPath, browserAddress: policy.network.runtimeAddress,
    privateInputOrigin: policy.privateInputOrigin, privateTakeoverOrigin: policy.privateTakeoverOrigin }) : renderInstanceServiceUnit(shared);
  const dir = runtime.manager === 'system' ? '/etc/systemd/system' : join(runtime.home, '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, unit.unitName); writeFileSync(path, unit.contents, { mode: 0o644 });
  if (runtime.manager === 'user') { chownSync(join(runtime.home, '.config/systemd'), runtime.uid, runtime.gid); chownSync(dir, runtime.uid, runtime.gid); chownSync(path, runtime.uid, runtime.gid); }
}
for (const unit of renderIsolationSupportUnits({ instanceId: personal.instanceId, nodePath: policy.nodePath, releasePath: release, namespace: policy.network.namespace, networkConfigPath: policy.networkConfigPath,
  endpointConfigPath: policy.endpointConfigPath, brokerConfigPath: policy.broker.configPath, brokerHome: policy.broker.home, brokerUser: policy.broker.user, runtimeGroup: personal.user })) {
  writeFileSync(join('/etc/systemd/system', unit.unitName), unit.contents, { mode: 0o644 });
}
