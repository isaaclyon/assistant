// Synthetic trusted-broker fixture. No Telegram, vault or external network is used.
// It speaks the unix-socket HTTP shape of the real trusted transport for getMe only.
import { chmodSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const server = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, result: { release: release.split('/').at(-1) } }));
});
server.listen(config.socketPath, () => chmodSync(config.socketPath, 0o660));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
