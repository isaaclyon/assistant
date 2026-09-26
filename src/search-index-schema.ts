import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;

interface SchemaVersionRow { schema_version: number }

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS search_index_metadata (
      singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version  INTEGER NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT
    ) STRICT;

    INSERT OR IGNORE INTO search_index_metadata (singleton, schema_version)
    VALUES (1, ${SCHEMA_VERSION});

    CREATE TABLE IF NOT EXISTS corpus_status (
      corpus          TEXT PRIMARY KEY CHECK (corpus IN ('memory', 'session')),
      last_attempt_at TEXT,
      last_success_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_document (
      rowid         INTEGER PRIMARY KEY,
      note_id       TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL UNIQUE,
      revision      TEXT NOT NULL,
      title         TEXT NOT NULL,
      tags          TEXT NOT NULL,
      tags_json     TEXT NOT NULL,
      body          TEXT NOT NULL,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL,
      scope         TEXT NOT NULL,
      owner         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    ) STRICT;

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title,
      tags,
      body,
      content = memory_document,
      content_rowid = rowid
    );

    CREATE TRIGGER IF NOT EXISTS memory_document_insert AFTER INSERT ON memory_document BEGIN
      INSERT INTO memory_fts(rowid, title, tags, body)
      VALUES (new.rowid, new.title, new.tags, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_document_delete AFTER DELETE ON memory_document BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, tags, body)
      VALUES ('delete', old.rowid, old.title, old.tags, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_document_update AFTER UPDATE ON memory_document BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, tags, body)
      VALUES ('delete', old.rowid, old.title, old.tags, old.body);
      INSERT INTO memory_fts(rowid, title, tags, body)
      VALUES (new.rowid, new.title, new.tags, new.body);
    END;

    CREATE TABLE IF NOT EXISTS session_document (
      rowid           INTEGER PRIMARY KEY,
      instance_id     TEXT NOT NULL,
      principal_id    TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      entry_id        TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      role            TEXT NOT NULL,
      project         TEXT,
      cwd             TEXT,
      source_path     TEXT NOT NULL,
      source_offset   INTEGER NOT NULL,
      searchable_text TEXT NOT NULL,
      UNIQUE (instance_id, principal_id, session_id, entry_id)
    ) STRICT;

    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      searchable_text,
      content = session_document,
      content_rowid = rowid
    );

    CREATE TRIGGER IF NOT EXISTS session_document_insert AFTER INSERT ON session_document BEGIN
      INSERT INTO session_fts(rowid, searchable_text)
      VALUES (new.rowid, new.searchable_text);
    END;

    CREATE TRIGGER IF NOT EXISTS session_document_delete AFTER DELETE ON session_document BEGIN
      INSERT INTO session_fts(session_fts, rowid, searchable_text)
      VALUES ('delete', old.rowid, old.searchable_text);
    END;

    CREATE TRIGGER IF NOT EXISTS session_document_update AFTER UPDATE ON session_document BEGIN
      INSERT INTO session_fts(session_fts, rowid, searchable_text)
      VALUES ('delete', old.rowid, old.searchable_text);
      INSERT INTO session_fts(rowid, searchable_text)
      VALUES (new.rowid, new.searchable_text);
    END;

    CREATE TABLE IF NOT EXISTS source_file_state (
      corpus          TEXT NOT NULL CHECK (corpus IN ('memory', 'session')),
      instance_id     TEXT NOT NULL DEFAULT '',
      principal_id    TEXT NOT NULL DEFAULT '',
      source_path     TEXT NOT NULL,
      device          INTEGER,
      inode           INTEGER,
      size_bytes      INTEGER,
      modified_ms     INTEGER,
      completed_offset INTEGER,
      prefix_hash      TEXT,
      scan_progress    TEXT,
      revision        TEXT,
      PRIMARY KEY (corpus, instance_id, principal_id, source_path)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_scan_cursor (
      instance_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      PRIMARY KEY (instance_id, principal_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_seen_entry (
      corpus TEXT NOT NULL DEFAULT 'session' CHECK (corpus = 'session'),
      instance_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      PRIMARY KEY (instance_id, principal_id, source_path, entry_id),
      FOREIGN KEY (corpus, instance_id, principal_id, source_path)
        REFERENCES source_file_state (corpus, instance_id, principal_id, source_path) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS memory_scan_source (
      source_path TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      document_json TEXT,
      warning TEXT CHECK (warning IS NULL OR warning = 'MALFORMED_NOTE')
    ) STRICT;
  `);
}


export function initializeSearchSchema(db: DatabaseSync): void {
  const hasMetadata = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'search_index_metadata'",
    )
    .get();
  if (hasMetadata !== undefined) {
    const existing = db
      .prepare("SELECT schema_version FROM search_index_metadata WHERE singleton = 1")
      .get() as unknown as SchemaVersionRow | undefined;
    if (existing !== undefined && existing.schema_version !== 1 && existing.schema_version !== SCHEMA_VERSION) {
      throw new Error(
        `Search index schema version ${existing.schema_version} is not supported; rebuild the derived index`,
      );
    }
  }
  initializeSchema(db);
  // Additive migration: canonical Markdown/JSONL and existing derived rows
  // remain untouched. Missing progress forces a source reparse on refresh.
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(source_file_state)").all();
    if (!columns.some((column) => column.name === "scan_progress")) {
      db.exec("ALTER TABLE source_file_state ADD COLUMN scan_progress TEXT");
    }
    const sessionSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_document'").get();
    if (String(sessionSchema?.sql).includes("UNIQUE (instance_id, session_id, entry_id)")) {
      db.exec(`
        DROP TRIGGER session_document_insert;
        DROP TRIGGER session_document_delete;
        DROP TRIGGER session_document_update;
        DROP TABLE session_fts;
        ALTER TABLE session_document RENAME TO session_document_legacy;
      `);
      initializeSchema(db);
      db.exec(`
        INSERT INTO session_document SELECT * FROM session_document_legacy;
        DROP TABLE session_document_legacy;
      `);
    }
    db.prepare("UPDATE search_index_metadata SET schema_version = ? WHERE singleton = 1").run(SCHEMA_VERSION);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
