// Synthetic child worker. Behaviour comes from <jobDir>/mode. "writer" is a flag file standing in for the store lock.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [stateDir, batchId, jobId] = process.argv.slice(2);
const dir = join(stateDir, batchId, jobId);
const mode = readFileSync(join(dir, 'mode'), 'utf8').trim();
const launchId = 'launch-1';
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'writer'), String(process.pid));
writeFileSync(join(dir, 'env.json'), JSON.stringify({ env: Object.keys(process.env), cwd: process.cwd() }));
const close = () => rmSync(join(dir, 'writer'), { force: true });
const outcome = (status) => writeFileSync(join(dir, 'outcome.json'), JSON.stringify({ batchId, jobId, launchId, version: 1, status, output: status, finishedAt: 1 }));
const ready = (id = launchId) => process.send({ event: 'ready', batchId, jobId, launchId: id });
const graceful = () => { close(); process.exit(0); };
if (mode === 'stubborn' || mode === 'stubborn-noready') process.on('SIGTERM', () => {});
else { process.on('SIGTERM', graceful); process.on('disconnect', graceful); }
if (mode === 'ok') { ready(); setTimeout(() => { close(); outcome('completed'); process.exit(0); }, 200); }
else if (mode === 'slowready') { setTimeout(() => { ready(); setTimeout(() => { close(); outcome('completed'); process.exit(0); }, 100); }, 600); }
else if (mode === 'hang') { ready(); setInterval(() => {}, 1000); }
else if (mode === 'noready' || mode === 'stubborn-noready') { setInterval(() => {}, 1000); }
else if (mode === 'stubborn') { ready(); setInterval(() => {}, 1000); }
else if (mode === 'badid') { ready('other'); setInterval(() => {}, 1000); }
else if (mode === 'flood') { ready(); process.stdout.write(Buffer.alloc(300 * 1024, 120)); setInterval(() => {}, 1000); }
else if (mode === 'crash') { ready(); setTimeout(() => { close(); process.exit(1); }, 100); }
else if (mode === 'cancelaware') {
  ready();
  setInterval(() => { if (existsSync(join(dir, 'cancel'))) { close(); outcome('cancelled'); process.exit(0); } }, 20);
}
