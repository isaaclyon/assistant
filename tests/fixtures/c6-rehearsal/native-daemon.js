// Synthetic native runtime fixture. Placed at dist/src/durable/daemon.js. It models
// readiness and one completed scheduled dispatch; it is NOT the real native host.
import { appendFileSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeMetadata, writeRuntimeMetadata } from '../runtime-metadata.js';
import { trustedTelegramFetch } from '../trusted-telegram-ipc.js';
const release = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const env = process.env;
const config = JSON.parse(readFileSync(env.PI_DURABLE_CONFIG, 'utf8'));
if (config.resourceRoot !== release || env.PI_TELEGRAM_BRIDGE_RELEASE_SHA !== config.releaseSha || release.split('/').at(-1) !== config.releaseSha) throw new Error('fixture release identity mismatch');
mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
const meta = status => writeRuntimeMetadata(join(config.stateDir, 'runtime.json'), createRuntimeMetadata({ instanceId: config.instanceId, releaseSha: config.releaseSha,
  pid: process.pid, status, principal: config.principal, telegramSurface: 'private', workspaceCwd: config.workspaceCwd, resourceRoot: release }));
await meta('starting');
let writable = true; try { writeFileSync(join(release, 'probe'), 'x'); } catch { writable = false; }
let broker = null;
if (config.transport.mode === 'broker') {
  const response = await trustedTelegramFetch(config.transport.socketPath)('https://api.telegram.org/bot0:runtime/getMe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  broker = (await response.json()).result.release;
}
writeFileSync(join(config.stateDir, 'fixture-evidence.json'), JSON.stringify({ generation: 'native', pid: process.pid, release: config.releaseSha, uid: process.getuid(), netns: readlinkSync('/proc/self/ns/net'), releaseWritable: writable, brokerRelease: broker }));
await meta('ready');
// One synthetic scheduled dispatch completes after the root CLI has recorded stable readiness (five one-second samples).
// The CLI requires the dispatch to be created after that readiness stamp.
setTimeout(() => writeFileSync(join(config.stateDir, 'canary-ledger.json'), JSON.stringify({ dispatchId: 'canary-0123456789abcdef', submissionId: `sub-${process.pid}`, createdAt: Date.now(), outcome: 'done' })), 8000);
setInterval(() => appendFileSync(join(config.stateDir, 'work.log'), `${process.pid}\n`), 500);
process.on('SIGTERM', async () => { await meta('stopping'); process.exit(0); });
