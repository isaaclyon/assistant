// Synthetic stand-in for dist/src/durable/inspect.js --canary-dispatch. It reads the
// synthetic ledger written by native-daemon.js and does not use the real native host.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(readFileSync(process.env.PI_DURABLE_CONFIG, 'utf8'));
const dispatchId = process.argv[process.argv.indexOf('--canary-dispatch') + 1];
const ledger = JSON.parse(readFileSync(join(config.stateDir, 'canary-ledger.json'), 'utf8'));
if (ledger.dispatchId !== dispatchId || ledger.outcome !== 'done') throw new Error('Canary scheduled work has no completed native admission');
console.log(JSON.stringify({ version: 1, instanceId: config.instanceId, dispatchId, submissionId: ledger.submissionId, outcome: 'done', createdAt: ledger.createdAt, inspectedAt: Date.now() }));
