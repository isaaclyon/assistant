// Synthetic legacy runtime fixture. Placed at dist/src/daemon.js in a test release.
// It uses the release's real runtime-metadata module and a synthetic broker reply.
import { appendFileSync, existsSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata.js';
import { trustedTelegramFetch } from './trusted-telegram-ipc.js';
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env, sha = env.PI_TELEGRAM_BRIDGE_RELEASE_SHA, id = env.PI_TELEGRAM_BRIDGE_INSTANCE_ID;
const principal = { 'c6-personal': 'isaac', 'c6-peer': 'emma' }[id];
if (!principal || !sha || release.split('/').at(-1) !== sha) throw new Error('fixture identity mismatch');
const stateDir = join(env.PI_TELEGRAM_BRIDGE_STATE_ROOT, 'instances', id);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const meta = status => writeRuntimeMetadata(join(stateDir, 'runtime.json'), createRuntimeMetadata({ instanceId: id, releaseSha: sha, pid: process.pid,
  status, principal, telegramSurface: 'private', workspaceCwd: process.cwd(), resourceRoot: release }));
await meta('starting');
let writable = true; try { writeFileSync(join(release, 'probe'), 'x'); } catch { writable = false; }
let broker = null;
if (env.PI_TELEGRAM_TRUSTED_SOCKET) {
  const response = await trustedTelegramFetch(env.PI_TELEGRAM_TRUSTED_SOCKET)('https://api.telegram.org/bot0:runtime/getMe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  broker = (await response.json()).result.release;
}
writeFileSync(join(stateDir, 'fixture-evidence.json'), JSON.stringify({ generation: 'legacy', pid: process.pid, release: sha, uid: process.getuid(), netns: readlinkSync('/proc/self/ns/net'), releaseWritable: writable, brokerRelease: broker }));
await meta('ready');
setInterval(() => appendFileSync(join(stateDir, 'work.log'), `${process.pid}\n`), 500);
// Test switch: when the administrator creates <stateDir>/insert-on-stop, a message is admitted while the runtime stops.
// This models a write that lands after the first inbox check and before every writer is quiescent.
process.on('SIGTERM', async () => {
  if (existsSync(join(stateDir, 'insert-on-stop'))) {
    const db = new DatabaseSync(join(stateDir, 'inbox.db'));
    db.exec('INSERT INTO pending_turn (id, payload, enqueued_at) VALUES (\'late\', \'{}\', 1)'); db.close();
  }
  await meta('stopping'); process.exit(0);
});
