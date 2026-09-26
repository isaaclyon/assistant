import type { DatabaseSync } from "node:sqlite";
import type { MemoryIndexDocument } from "./search-index-types.js";

export interface MemoryScanEntry {
  fingerprint: string;
  document: MemoryIndexDocument | null;
  warning: "MALFORMED_NOTE" | null;
}

export interface MemoryScanStore {
  get(path: string): MemoryScanEntry | undefined;
  set(path: string, entry: MemoryScanEntry): void;
  retain(paths: Set<string>): void;
}

function parseDocument(raw: string): MemoryIndexDocument {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("Invalid staged memory document");
  const row = value as Record<string, unknown>;
  const string = (key: string): string => {
    if (typeof row[key] !== "string") throw new Error("Invalid staged memory field");
    return row[key];
  };
  if (!Array.isArray(row.tags) || !row.tags.every((tag): tag is string => typeof tag === "string") ||
      (row.owner !== null && typeof row.owner !== "string")) {
    throw new Error("Invalid staged memory metadata");
  }
  return {
    noteId: string("noteId"), relativePath: string("relativePath"), revision: string("revision"),
    title: string("title"), tags: row.tags, body: string("body"), type: string("type"),
    status: string("status"), scope: string("scope"), owner: row.owner,
    createdAt: string("createdAt"), updatedAt: string("updatedAt"),
  };
}

export function createMemoryScanStore(db: DatabaseSync): MemoryScanStore {
  return {
    get(path) {
      const row = db.prepare("SELECT * FROM memory_scan_source WHERE source_path = ?").get(path);
      if (row === undefined) return undefined;
      if (typeof row.fingerprint !== "string" ||
          (row.warning !== null && row.warning !== "MALFORMED_NOTE") ||
          (row.document_json !== null && typeof row.document_json !== "string")) {
        throw new Error("Invalid staged memory source");
      }
      return {
        fingerprint: row.fingerprint,
        document: row.document_json === null ? null : parseDocument(row.document_json),
        warning: row.warning,
      };
    },
    set(path, entry) {
      db.prepare(`INSERT INTO memory_scan_source VALUES (?, ?, ?, ?)
        ON CONFLICT (source_path) DO UPDATE SET fingerprint = excluded.fingerprint,
          document_json = excluded.document_json, warning = excluded.warning`)
        .run(path, entry.fingerprint, entry.document === null ? null : JSON.stringify(entry.document), entry.warning);
    },
    retain(paths) {
      const remove = db.prepare("DELETE FROM memory_scan_source WHERE source_path = ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of db.prepare("SELECT source_path FROM memory_scan_source").all()) {
          const path = String(row.source_path);
          if (!paths.has(path)) remove.run(path);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
