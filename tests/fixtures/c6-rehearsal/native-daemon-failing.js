// Synthetic native fixture whose startup fails after the process begins; models a crashing candidate.
// Before it exits it admits one pending row to the state inbox, as a native host legitimately can once it has started.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const config = JSON.parse(readFileSync(process.env.PI_DURABLE_CONFIG, 'utf8'));
const db = new DatabaseSync(join(config.stateDir, 'inbox.db'));
db.exec('CREATE TABLE IF NOT EXISTS pending_turn (id TEXT PRIMARY KEY, payload TEXT, enqueued_at INTEGER)');
db.exec("INSERT INTO pending_turn (id, payload, enqueued_at) VALUES ('native-row', '{}', 1)"); db.close();
console.error('fixture native runtime failed during startup');
process.exit(1);
