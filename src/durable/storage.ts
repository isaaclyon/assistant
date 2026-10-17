import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';

export class InboxStorageError extends Error {}
export class InboxPayloadConflict extends Error {}
function inboxOperation<T>(operation:()=>T):T {
  try{return operation();}catch(error){if(error instanceof InboxPayloadConflict)throw error;throw new InboxStorageError('Durable inbox operation failed',{cause:error});}
}

/** An OS-released SQLite write lock: no PID guessing or stale-file deletion. */
export async function openHostStorage(stateDir: string, inboxPath?: string) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(stateDir);
  const lease = new DatabaseSync(join(directory, 'writer.lock.db'));
  let inbox: DatabaseSync | undefined;
  let storage: SqliteStorage | undefined;
  try {
    lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const database = await openNodeSqliteDatabase(join(directory, 'harness.db'));
    try {
      await database.exec('PRAGMA synchronous=FULL');
      if ((await database.get<{synchronous:number}>('PRAGMA synchronous'))?.synchronous !== 2 ||
          (await database.get<{journal_mode:string}>('PRAGMA journal_mode'))?.journal_mode !== 'wal') throw new Error('WAL/FULL required');
      storage = await SqliteStorage.open(database);
    } catch (error) { await database.close(); throw error; }
    inbox = new DatabaseSync(inboxPath ?? join(directory, 'inbox.db'));
    inbox.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS pending_turn (id TEXT PRIMARY KEY, payload TEXT NOT NULL, enqueued_at INTEGER NOT NULL)');
    const db = inbox;
    return {
      storage, database,
      inbox: {
        persist(id: string, payload: string, now: number) {
          return inboxOperation(()=>{
          const existing = db.prepare('SELECT payload FROM pending_turn WHERE id=?').get(id);
          if (existing && existing.payload !== payload) throw new InboxPayloadConflict('Inbox payload conflict');
          db.prepare('INSERT OR IGNORE INTO pending_turn VALUES (?,?,?)').run(id, payload, now);
          });
        },
        remove(id: string) { inboxOperation(()=>db.prepare('DELETE FROM pending_turn WHERE id=?').run(id)); },
        pending() { return inboxOperation(()=>db.prepare('SELECT id,payload FROM pending_turn ORDER BY rowid').all() as unknown as {id:string;payload:string}[]); },
      },
      release() { if (db.isOpen) db.close(); if (lease.isOpen) lease.close(); },
    };
  } catch (error) { try{await storage?.close(BACKGROUND_CONTEXT);}finally{inbox?.close();lease.close();} throw error; }
}
export type HostStorage = Awaited<ReturnType<typeof openHostStorage>>;
