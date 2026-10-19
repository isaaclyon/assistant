// Writes synthetic administrator and runtime configuration for the C6 activation rehearsal.
// Usage: make-config.mjs world | native <personal|peer> <sha> | stage <json-spec>
import { chmodSync, chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const id = (user, flag) => Number(execFileSync('/usr/bin/id', [flag, user]).toString().trim());
export const W = { live: '/opt/c6-live', releaseRoot: '/opt/c6-live/releases', node: '/opt/c6-live/node/bin/node', etc: '/etc/c6-live', checkpoints: '/var/lib/c6-checkpoints',
  personal: { instanceId: 'c6-personal', user: 'c6personal', home: '/var/lib/c6personal', configRoot: '/etc/c6-live/personal', stateRoot: '/var/lib/c6personal/state', agentDir: '/var/lib/c6personal/agent', manifestPath: '/etc/c6-live/personal/instances.json', principal: 'isaac', profile: 'isaacprof', workspace: '/var/lib/c6personal/workspace' },
  peer: { instanceId: 'c6-peer', user: 'c6peer', home: '/home/c6peer', configRoot: '/home/c6peer/.config/c6', stateRoot: '/home/c6peer/.local/state/c6', agentDir: '/home/c6peer/.pi/agent', manifestPath: '/home/c6peer/.config/c6/instances.json', principal: 'emma', profile: 'emmaprof', workspace: '/home/c6peer/workspace' },
  broker: { user: 'c6broker', home: '/var/lib/c6broker', configPath: '/etc/c6-live/broker/broker.json', stateDir: '/var/lib/c6broker/state' } };
const socketPath = '/run/pi-broker-c6-personal/telegram.sock';
function put(path, value, { mode = 0o644, owner = [0, 0] } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  chownSync(path, owner[0], owner[1]); chmodSync(path, mode);
}
function dir(path, owner, mode) { mkdirSync(path, { recursive: true }); chownSync(path, owner[0], owner[1]); chmodSync(path, mode); }
const ident = user => [id(user, '-u'), id(user, '-g')];
function runtime(kind, manager) {
  const r = W[kind], [uid, gid] = ident(r.user);
  return { instanceId: r.instanceId, user: r.user, uid, gid, home: r.home, manager, manifestPath: r.manifestPath, configRoot: r.configRoot, stateRoot: r.stateRoot, agentDir: r.agentDir };
}
const command = process.argv[2];
if (command === 'world') {
  const network = { namespace: 'pi-c6', hostInterface: 'pic6', subnet: '10.77.12.0/30', hostAddress: '10.77.12.1', runtimeAddress: '10.77.12.2', dns: '10.77.12.1', localServices: [], proxyPorts: [8446, 8447] };
  const [bu, bg] = ident(W.broker.user);
  const deploy = { version: 1, nodePath: W.node, releaseRoot: W.releaseRoot, checkpointRoot: W.checkpoints, runtimes: [runtime('personal', 'system'), runtime('peer', 'user')],
    broker: { user: W.broker.user, uid: bu, gid: bg, home: W.broker.home, configPath: W.broker.configPath, stateDir: W.broker.stateDir },
    network, networkConfigPath: `${W.etc}/network.json`, endpointConfigPath: `${W.etc}/endpoint.json`, resolverPath: `${W.etc}/resolv.conf`,
    privateInputOrigin: 'https://c6host.c6net.ts.net:8446', privateTakeoverOrigin: 'https://c6host.c6net.ts.net:8447' };
  put(`${W.etc}/deploy.json`, deploy); put(`${W.etc}/network.json`, network);
  put(`${W.etc}/endpoint.json`, { PI_PRIVATE_BROWSER_BIND_ADDRESS: network.runtimeAddress, PI_PRIVATE_INPUT_ORIGIN: deploy.privateInputOrigin, PI_PRIVATE_TAKEOVER_ORIGIN: deploy.privateTakeoverOrigin });
  put(`${W.etc}/resolv.conf`, 'nameserver 10.77.12.1\n');
  const [pu, pg] = ident('c6personal'), [eu, eg] = ident('c6peer');
  const manifest = (r, surface, scope, memory, jobs) => ({ version: 1, instances: [{ id: r.instanceId, displayName: r.instanceId, principal: r.principal, telegramProfile: r.profile, telegramSurface: { type: 'private' },
    workspaceCwd: r.workspace, capabilityProfile: surface, credentialScope: scope, memoryView: memory, jobsRole: jobs }] });
  put(W.personal.manifestPath, manifest(W.personal, 'personal-isaac', 'isaac-personal', 'owner-and-household', 'coordinator'), { mode: 0o440 });
  put(`${W.personal.configRoot}/instances/c6-personal.env`, 'PI_TELEGRAM_CREDENTIAL_SCOPE=isaac-personal\n', { mode: 0o440 });
  put(`${W.personal.configRoot}/isolation-policy.json`, { uid: pu, gid: pg, paths: [
    { role: 'releases', path: W.releaseRoot, kind: 'immutable' }, { role: 'home', path: W.personal.home, kind: 'private-directory' },
    { role: 'broker-state', path: W.broker.stateDir, kind: 'inaccessible' }, { role: 'checkpoints', path: W.checkpoints, kind: 'inaccessible' }] });
  put(W.peer.manifestPath, manifest(W.peer, 'personal-emma', 'emma-personal', 'owner-and-household', 'target-only'), { mode: 0o600, owner: [eu, eg] });
  put(`${W.peer.configRoot}/instances/c6-peer.env`, 'PI_TELEGRAM_CREDENTIAL_SCOPE=emma-personal\n', { mode: 0o600, owner: [eu, eg] });
  put(`${W.peer.agentDir}/telegram.json`, { profiles: { emmaprof: { botToken: '2:synthetic', allowedUserId: 2 } } }, { mode: 0o600, owner: [eu, eg] });
  for (const p of [W.peer.configRoot, `${W.peer.configRoot}/instances`, `${W.peer.home}/.config`, `${W.peer.home}/.pi`, W.peer.agentDir, `${W.peer.home}/.local`, `${W.peer.home}/.local/state`, W.peer.workspace]) dir(p, [eu, eg], 0o700);
  dir(W.peer.stateRoot, [eu, eg], 0o700);
  for (const p of [W.personal.home, W.personal.stateRoot, W.personal.agentDir, W.personal.workspace]) dir(p, [pu, pg], 0o700);
  dir(W.broker.home, [bu, bg], 0o700); dir(W.broker.stateDir, [bu, bg], 0o700); dir(dirname(W.broker.configPath), [bu, bg], 0o700);
  const vault = { binary: `${W.live}/fake-op`, tokenFile: `${W.broker.home}/config/token`, sourceVault: 'a'.repeat(26), sourceName: 'synthetic', destinationVault: 'b'.repeat(26), home: W.broker.home };
  put(vault.tokenFile, 'synthetic', { mode: 0o600, owner: [bu, bg] });
  put(W.broker.configPath, { version: 1, instance: 'c6-personal', botToken: '1:synthetic', userId: 1, initialOffset: 0, socketPath, databasePath: `${W.broker.stateDir}/telegram.db`, vault }, { mode: 0o600, owner: [bu, bg] });
  dir(W.checkpoints, [0, 0], 0o700);
} else if (command === 'native') {
  const [, , , kind, sha] = process.argv, r = W[kind], [uid, gid] = ident(r.user);
  const common = { version: 1, runtime: 'pi-durable', instanceId: r.instanceId, principal: r.principal, releaseSha: sha, resourceRoot: `${W.releaseRoot}/${sha}`, workspaceCwd: r.workspace,
    stateDir: `${r.stateRoot}/instances/${r.instanceId}`, capabilityProfile: kind === 'personal' ? 'durable-jobs-coordinator-test' : 'durable-personal-emma' };
  const config = kind === 'personal' ? { ...common, jobsRole: 'coordinator', transport: { mode: 'broker', socketPath, botId: 1, allowedUserId: 1 },
    coordinator: { scope: 'self', targets: [r.instanceId], stateRoot: r.stateRoot, coordinatorStateDir: `${r.stateRoot}/coordinator` } }
    : { ...common, jobsRole: 'recipient', transport: { mode: 'ordinary', locksPath: `${r.stateRoot}/telegram-locks`, botId: 2, allowedUserId: 2, configPath: `${r.agentDir}/telegram.json`, profile: r.profile } };
  const path = `${r.home}/native-${sha}.json`;
  put(path, config, { mode: 0o600, owner: [uid, gid] }); console.log(path);
} else if (command === 'stage') {
  const spec = JSON.parse(process.argv[3]);
  const entry = (kind, [generation, sha]) => ({ instanceId: W[kind].instanceId, runtime: generation, releaseSha: sha,
    ...(generation === 'pi-durable' ? { nativeConfigPath: `${W[kind].home}/native-${sha}.json` } : {}) });
  const plan = { version: 1, stageId: spec.stageId, selectedInstance: W[spec.selected].instanceId, releaseRoot: W.releaseRoot, brokerReleaseSha: spec.broker, observationMs: spec.observationMs ?? 8000,
    previous: ['personal', 'peer'].map(kind => entry(kind, spec.previous[kind])), desired: ['personal', 'peer'].map(kind => entry(kind, spec.desired[kind])) };
  put(spec.path, plan);
} else if (command === 'observe') { put(process.argv[3], { dispatchId: process.argv[4] }); }
else throw new Error('unknown command');
