import { DatabaseSync } from "node:sqlite";

/**
 * A single accepted-but-not-yet-dispatched Telegram prompt turn.
 *
 * `id` is the turn's stable identity, chosen by the pinned pi-telegram fork
 * (`chatId:minSourceMessageId`); it doubles as the idempotency key against
 * Telegram redelivery and startup replay. `payload` is opaque to the host: the
 * fork owns its shape (serialized routing, content, attachment refs, voice
 * flags) so that no routing logic is duplicated on this side of the boundary.
 * See docs/adr/0003-durable-inbound-inbox.md.
 */
export interface PendingInboundTurn {
  id: string;
  payload: string;
}

/**
 * Durable at-least-once inbox for inbound Telegram turns.
 *
 * A row exists exactly while a turn has been accepted but is not yet safely in
 * Pi's hands. The fork persists on accept (before the Telegram offset advances),
 * removes once the turn is handed to Pi (whose own session JSONL then owns it),
 * and replays whatever remains on startup.
 */
export interface InboundInbox {
  persist(id: string, payload: string, now: number): void;
  remove(id: string): void;
  loadPending(): PendingInboundTurn[];
  close(): void;
}

interface PendingTurnRow {
  id: string;
  payload: string;
}

/**
 * Open (creating if needed) the durable inbox at `dbPath`. The parent directory
 * must already exist — the host creates `stateDir` before calling this.
 */
export function openInbox(dbPath: string): InboundInbox {
  const db = new DatabaseSync(dbPath);
  // WAL keeps a stray concurrent reader from blocking the single host writer;
  // NORMAL is durable across process crashes (only bare OS crashes can lose the
  // last committed WAL frame), which is the boundary this inbox defends.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(
    `CREATE TABLE IF NOT EXISTS pending_turn (
       id          TEXT PRIMARY KEY,
       payload     TEXT NOT NULL,
       enqueued_at INTEGER NOT NULL
     )`,
  );

  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO pending_turn (id, payload, enqueued_at) VALUES (?, ?, ?)",
  );
  const deleteStmt = db.prepare("DELETE FROM pending_turn WHERE id = ?");
  const selectStmt = db.prepare(
    "SELECT id, payload FROM pending_turn ORDER BY enqueued_at ASC, id ASC",
  );

  return {
    persist(id, payload, now) {
      insertStmt.run(id, payload, now);
    },
    remove(id) {
      deleteStmt.run(id);
    },
    loadPending() {
      const rows = selectStmt.all() as unknown as PendingTurnRow[];
      return rows.map((row) => ({ id: row.id, payload: row.payload }));
    },
    close() {
      // Idempotent: the host's single-flight disposal may reach this after an
      // earlier error path already closed the database.
      if (db.isOpen) db.close();
    },
  };
}
