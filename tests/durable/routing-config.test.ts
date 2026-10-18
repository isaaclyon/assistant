import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, link, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadNativeConfig } from '../../src/durable/config.js';
import { nativeMemoryEnvironment } from '../../src/durable/environment.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(profile = 'durable-chat-memory-test') {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'routing-config-'))); dirs.push(root);
 const release = join(root, 'release'), workspace = join(root, 'workspace'), state = join(root, 'state');
 await Promise.all([release, workspace, state].map(path => mkdir(path, { mode: 0o700 })));
 const key = join(root, 'routing-key'); await writeFile(key, 'k', { mode: 0o600 }); await chmod(key, 0o600);
 const config: any = { version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40), resourceRoot: release, workspaceCwd: workspace, stateDir: state, capabilityProfile: profile, account: 'test', credentialPath: join(root, 'auth.json'), settingsPath: join(root, 'settings.json'), jobsRole: 'disabled', transport: { mode: 'broker', socketPath: join(root, 'b.sock'), botId: 1, allowedUserId: 2 },
  memory: { vaultRoot: join(root, 'vault'), gitAutocommit: false, legacySessionRoots: [], timeZone: 'UTC', recall: 'off', semantic: 'off' } };
 const path = join(root, 'instance.json');
 const save = () => writeFile(path, JSON.stringify(config), { mode: 0o600 });
 await save();
 return { root, key, config, path, save };
}
test('absent routing is off and independent of recall', async () => {
 const f = await fixture(); const loaded = await loadNativeConfig(f.path);
 expect(loaded.routing).toBeUndefined(); expect(nativeMemoryEnvironment(loaded).PI_TELEGRAM_SESSION_ROUTING).toBe('off');
});
test('enabled routing keeps recall off and uses its own key', async () => {
 const f = await fixture(); f.config.routing = { mode: 'jev', judgeKeyFile: f.key }; await f.save();
 const loaded = await loadNativeConfig(f.path);
 expect(loaded.routing).toEqual({ mode: 'jev', judgeKeyFile: f.key });
 const env = nativeMemoryEnvironment(loaded);
 expect(env).toMatchObject({ PI_TELEGRAM_SESSION_ROUTING: 'jev', PI_TELEGRAM_MEMORY_RECALL: 'off' });
 expect(env.PI_TELEGRAM_TYPESAFE_API_KEY_FILE).toBeUndefined();
});
test('rejects malformed routing selections', async () => {
 const f = await fixture();
 for (const routing of [{ mode: 'off', judgeKeyFile: f.key }, { mode: 'jev' }, { mode: 'jev', judgeKeyFile: f.key, extra: 1 }, { mode: 'jev', judgeKeyFile: 'relative' }, 'jev']) {
  f.config.routing = routing; await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow();
 }
});
test('rejects unsafe routing key files', async () => {
 const f = await fixture(); f.config.routing = { mode: 'jev', judgeKeyFile: f.key }; await f.save();
 await chmod(f.key, 0o640); await expect(loadNativeConfig(f.path)).rejects.toThrow(/Routing judge key/);
 await chmod(f.key, 0o600); await writeFile(f.key, ''); await expect(loadNativeConfig(f.path)).rejects.toThrow(/Routing judge key/);
 await writeFile(f.key, 'x'.repeat(4097)); await expect(loadNativeConfig(f.path)).rejects.toThrow(/Routing judge key/);
 await writeFile(f.key, 'k'); await link(f.key, join(f.root, 'second')); await expect(loadNativeConfig(f.path)).rejects.toThrow(/Routing judge key/);
 const target = join(f.root, 'real'); await writeFile(target, 'k', { mode: 0o600 }); const alias = join(f.root, 'alias'); await symlink(target, alias);
 f.config.routing.judgeKeyFile = alias; await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow(/Routing judge key/);
 f.config.routing.judgeKeyFile = join(f.root, 'missing'); await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow();
});
test('routing authorization does not require a canonical memory domain', async () => {
 const f = await fixture('durable-foundation-test'); delete f.config.memory; f.config.routing = { mode: 'jev', judgeKeyFile: f.key }; await f.save();
 await expect(loadNativeConfig(f.path)).resolves.toMatchObject({routing:{mode:'jev',judgeKeyFile:f.key}});
});
