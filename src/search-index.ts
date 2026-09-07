import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";

import { initializeSearchSchema, SCHEMA_VERSION } from "./search-index-schema.js";
import { createMemoryScanStore } from "./memory-scan-store.js";
import type {
  SearchCorpus,
  CorpusOperationStatus,
  SearchIndex,
  MemoryDocumentSearchPage,
  MemorySearchPage,
  SessionIndexDocument,
  SessionSourceState,
  SessionSeenEntry,
  SessionSourceProgress,
  SessionSearchPage,
  SessionDocumentSearchPage,
  OpenSearchIndexOptions
} from "./search-index-types.js";
export type * from "./search-index-types.js";

const DATABASE_NAME = "search-index.db";

function parseSourceProgress(raw: string | null): SessionSourceProgress | undefined {
  if (raw === null) return undefined;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("Invalid search source progress");
  const record = value as Record<string, unknown>;
  const completion = record.completion;
  if (record.discardingLine !== undefined && typeof record.discardingLine !== "boolean") {
    throw new Error("Invalid search source line state");
  }
  if (completion !== "clean-eof" && completion !== "budget-exhausted" &&
      completion !== "incomplete-tail" && completion !== "file-truncated" && completion !== "file-replaced") {
    throw new Error("Invalid search source completion");
  }
  if (!Array.isArray(record.warnings) || record.warnings.length > 20 || typeof record.warningsTruncated !== "boolean") {
    throw new Error("Invalid search source warnings");
  }
  const warnings = record.warnings.map((warning: unknown) => {
    if (typeof warning !== "object" || warning === null) throw new Error("Invalid search warning");
    const entry = warning as Record<string, unknown>;
    if (typeof entry.code !== "string" || (entry.byteOffset !== undefined &&
        (typeof entry.byteOffset !== "number" || !Number.isSafeInteger(entry.byteOffset) || entry.byteOffset < 0))) {
      throw new Error("Invalid search warning");
    }
    return { code: entry.code, ...(entry.byteOffset === undefined ? {} : { byteOffset: entry.byteOffset as number }) };
  });
  return { completion, warnings, warningsTruncated: record.warningsTruncated,
    ...(record.discardingLine === undefined ? {} : { discardingLine: record.discardingLine }) };
}


interface CountRow {
  count: number;
}

interface MemoryMatchRow {
  note_id: string;
  score: number;
  snippet: string;
}

interface MemoryDocumentMatchRow extends MemoryMatchRow {
  schema: number;
  relative_path: string;
  type: string;
  status: string;
  scope: string;
  owner: string | null;
  title: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
  revision: string;
}

interface SessionMatchRow {
  instance_id: string;
  principal_id: string;
  session_id: string;
  entry_id: string;
  timestamp: string;
  role: string;
  project: string | null;
  source_path: string;
  source_offset: number;
  score: number;
  snippet: string;
}

interface SessionSourceStateRow {
  instance_id: string;
  principal_id: string;
  source_path: string;
  device: number;
  inode: number;
  size_bytes: number;
  modified_ms: number;
  completed_offset: number;
  prefix_hash: string;
  scan_progress: string | null;
}

interface EntryIdRow {
  entry_id: string;
}

interface SessionDocumentRow {
  instance_id: string;
  principal_id: string;
  session_id: string;
  entry_id: string;
  timestamp: string;
  role: string;
  project: string | null;
  cwd: string | null;
  source_path: string;
  source_offset: number;
  searchable_text: string;
}

interface CorpusStatusRow {
  corpus: SearchCorpus;
  last_attempt_at: string | null;
  last_success_at: string | null;
}

const MAX_SEARCH_LIMIT = 100;
const MAX_QUERY_LENGTH = 512;

function boundSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit)));
}

function literalFallbackQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms
    .slice(0, 32)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function boundSnippet(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 240) return value;
  return `${characters.slice(0, 239).join("")}…`;
}


export function openSearchIndex(options: OpenSearchIndexOptions): SearchIndex {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(options.stateDir, 0o700);

  const databasePath = join(options.stateDir, DATABASE_NAME);
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  try {
    initializeSearchSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const memoryCount = db.prepare("SELECT count(*) AS count FROM memory_document");
  const sessionCount = db.prepare("SELECT count(*) AS count FROM session_document");
  const insertMemory = db.prepare(`
    INSERT INTO memory_document (
      note_id, relative_path, revision, title, tags, tags_json, body, type, status,
      scope, owner, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const searchMemory = db.prepare(`
    SELECT
      memory_document.note_id,
      bm25(memory_fts, 5.0, 2.0, 1.0) AS score,
      snippet(memory_fts, 2, '', '', ' … ', 24) AS snippet
    FROM memory_fts
    JOIN memory_document ON memory_document.rowid = memory_fts.rowid
    WHERE memory_fts MATCH ?
    ORDER BY score ASC, memory_document.note_id ASC
    LIMIT ?
  `);
  const memoryDocumentSelect = `
    SELECT
      memory_document.note_id,
      2 AS schema,
      memory_document.relative_path,
      memory_document.type,
      memory_document.status,
      memory_document.scope,
      memory_document.owner,
      memory_document.title,
      memory_document.tags_json,
      memory_document.created_at,
      memory_document.updated_at,
      memory_document.revision,
      bm25(memory_fts, 5.0, 2.0, 1.0) AS score,
      snippet(memory_fts, 2, '', '', ' … ', 24) AS snippet
    FROM memory_fts
    JOIN memory_document ON memory_document.rowid = memory_fts.rowid
  `;
  const insertSession = db.prepare(`
    INSERT INTO session_document (
      instance_id, principal_id, session_id, entry_id, timestamp, role,
      project, cwd, source_path, source_offset, searchable_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const searchSessions = db.prepare(`
    SELECT
      session_document.instance_id,
      session_document.principal_id,
      session_document.session_id,
      session_document.entry_id,
      session_document.timestamp,
      session_document.role,
      session_document.project,
      session_document.source_path,
      session_document.source_offset,
      bm25(session_fts) AS score,
      snippet(session_fts, 0, '', '', ' … ', 24) AS snippet
    FROM session_fts
    JOIN session_document ON session_document.rowid = session_fts.rowid
    WHERE session_fts MATCH ?
    ORDER BY score ASC, session_document.timestamp DESC,
      session_document.instance_id ASC, session_document.session_id ASC,
      session_document.entry_id ASC
    LIMIT ?
  `);
  const sessionDocumentSelect = `
    SELECT
      session_document.instance_id,
      session_document.principal_id,
      session_document.session_id,
      session_document.entry_id,
      session_document.timestamp,
      session_document.role,
      session_document.project,
      session_document.source_path,
      session_document.source_offset,
      bm25(session_fts) AS score,
      snippet(session_fts, 0, '', '', ' … ', 24) AS snippet
    FROM session_fts
    JOIN session_document ON session_document.rowid = session_fts.rowid
  `;
  const selectSessionSource = db.prepare(`
    SELECT instance_id, principal_id, source_path, device, inode, size_bytes,
      modified_ms, completed_offset, prefix_hash, scan_progress
    FROM source_file_state
    WHERE corpus = 'session' AND instance_id = ? AND principal_id = ? AND source_path = ?
  `);
  const listSessionSources = db.prepare(`
    SELECT instance_id, principal_id, source_path, device, inode, size_bytes,
      modified_ms, completed_offset, prefix_hash, scan_progress
    FROM source_file_state
    WHERE corpus = 'session' AND instance_id = ? AND principal_id = ?
    ORDER BY source_path ASC
  `);
  const selectSessionEntryIds = db.prepare(`
    SELECT entry_id FROM session_document
    WHERE instance_id = ? AND principal_id = ? AND source_path = ? AND source_offset < ?
    UNION
    SELECT entry_id FROM session_seen_entry
    WHERE instance_id = ? AND principal_id = ? AND source_path = ? AND source_offset < ?
    ORDER BY entry_id ASC
  `);
  const insertSeenEntry = db.prepare(`INSERT INTO session_seen_entry
    (instance_id, principal_id, source_path, entry_id, source_offset) VALUES (?, ?, ?, ?, ?)`);
  const deleteSeenEntries = db.prepare(`DELETE FROM session_seen_entry
    WHERE instance_id = ? AND principal_id = ? AND source_path = ?`);
  const saveSeenEntries = (state: SessionSourceState, entries: SessionSeenEntry[]): void => {
    for (const entry of entries) insertSeenEntry.run(state.instanceId, state.principalId, state.sourcePath, entry.entryId, entry.byteOffset);
  };
  const selectSessionDocument = db.prepare(`
    SELECT instance_id, principal_id, session_id, entry_id, timestamp, role,
      project, cwd, source_path, source_offset, searchable_text
    FROM session_document
    WHERE instance_id = ? AND principal_id = ? AND session_id = ? AND entry_id = ?
  `);
  const deleteSessionDocumentsForSource = db.prepare(`
    DELETE FROM session_document
    WHERE instance_id = ? AND principal_id = ? AND source_path = ?
  `);
  const deleteSessionDocumentsForBoundary = db.prepare(`
    DELETE FROM session_document
    WHERE instance_id = ? AND principal_id = ?
  `);
  const upsertSessionSource = db.prepare(`
    INSERT INTO source_file_state (
      corpus, instance_id, principal_id, source_path, device, inode,
      size_bytes, modified_ms, completed_offset, prefix_hash, scan_progress, revision
    ) VALUES ('session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (corpus, instance_id, principal_id, source_path) DO UPDATE SET
      device = excluded.device,
      inode = excluded.inode,
      size_bytes = excluded.size_bytes,
      modified_ms = excluded.modified_ms,
      completed_offset = excluded.completed_offset,
      prefix_hash = excluded.prefix_hash,
      scan_progress = excluded.scan_progress,
      revision = NULL
  `);
  const deleteSessionSourceState = db.prepare(`
    DELETE FROM source_file_state
    WHERE corpus = 'session' AND instance_id = ? AND principal_id = ? AND source_path = ?
  `);
  const deleteSessionSourceStatesForBoundary = db.prepare(`
    DELETE FROM source_file_state
    WHERE corpus = 'session' AND instance_id = ? AND principal_id = ?
  `);
  const recordCorpusAttempt = db.prepare(`
    INSERT INTO corpus_status (corpus, last_attempt_at, last_success_at)
    VALUES (?, ?, NULL)
    ON CONFLICT (corpus) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
  `);
  const recordCorpusSuccess = db.prepare(`
    INSERT INTO corpus_status (corpus, last_attempt_at, last_success_at)
    VALUES (?, NULL, ?)
    ON CONFLICT (corpus) DO UPDATE SET last_success_at = excluded.last_success_at
  `);
  const selectCorpusStatuses = db.prepare(`
    SELECT corpus, last_attempt_at, last_success_at
    FROM corpus_status
    ORDER BY corpus ASC
  `);

  const insertSessionDocuments = (documents: SessionIndexDocument[]): void => {
    for (const document of documents) {
      insertSession.run(
        document.instanceId,
        document.principalId,
        document.sessionId,
        document.entryId,
        document.timestamp,
        document.role,
        document.project,
        document.cwd,
        document.sourcePath,
        document.sourceOffset,
        document.searchableText,
      );
    }
  };
  const saveSessionSourceState = (state: SessionSourceState): void => {
    upsertSessionSource.run(
      state.instanceId,
      state.principalId,
      state.sourcePath,
      state.device,
      state.inode,
      state.sizeBytes,
      state.modifiedMs,
      state.completedOffset,
      state.prefixHash,
      state.progress === undefined ? null : JSON.stringify(state.progress),
    );
  };
  const mapSessionSourceState = (row: SessionSourceStateRow): SessionSourceState => {
    const progress = parseSourceProgress(row.scan_progress);
    return {
    instanceId: row.instance_id,
    principalId: row.principal_id,
    sourcePath: row.source_path,
    device: row.device,
    inode: row.inode,
    sizeBytes: row.size_bytes,
    modifiedMs: row.modified_ms,
    completedOffset: row.completed_offset,
    prefixHash: row.prefix_hash,
    ...(progress === undefined ? {} : { progress }),
    };
  };

  return {
    withRefreshLock(corpus, operation) {
      return withMutationLock(join(options.stateDir, `.search-${corpus}-lock.sqlite`), operation);
    },
    memoryScan: createMemoryScanStore(db),
    sessionScanCursor(instanceId, principalId) {
      const row = db.prepare("SELECT source_path FROM session_scan_cursor WHERE instance_id = ? AND principal_id = ?")
        .get(instanceId, principalId);
      return row === undefined ? undefined : String(row.source_path);
    },
    setSessionScanCursor(instanceId, principalId, path) {
      db.prepare(`INSERT INTO session_scan_cursor VALUES (?, ?, ?)
        ON CONFLICT (instance_id, principal_id) DO UPDATE SET source_path = excluded.source_path`)
        .run(instanceId, principalId, path);
    },
    sessionContextStart(instanceId, principalId, path, targetOffset, before) {
      const rows = db.prepare(`SELECT source_offset FROM session_document
        WHERE instance_id = ? AND principal_id = ? AND source_path = ? AND source_offset < ?
        ORDER BY source_offset DESC LIMIT ?`).all(instanceId, principalId, path, targetOffset, before + 1);
      const first = before === 0 ? undefined : rows[Math.min(before, rows.length) - 1];
      return { offset: first === undefined ? targetOffset : Number(first.source_offset), hasMoreBefore: rows.length > before };
    },
    status() {
      return {
        schemaVersion: SCHEMA_VERSION,
        memoryDocuments: (memoryCount.get() as unknown as CountRow).count,
        sessionDocuments: (sessionCount.get() as unknown as CountRow).count,
      };
    },
    replaceMemoryDocuments(documents) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM memory_document");
        for (const document of documents) {
          insertMemory.run(
            document.noteId,
            document.relativePath,
            document.revision,
            document.title,
            document.tags.join(" "),
            JSON.stringify(document.tags),
            document.body,
            document.type,
            document.status,
            document.scope,
            document.owner,
            document.createdAt,
            document.updatedAt,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    searchMemory(query, limit) {
      const boundedLimit = boundSearchLimit(limit);
      const boundedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
      if (boundedQuery.length === 0) return { results: [], truncated: false };

      let rows: MemoryMatchRow[];
      let warning: MemorySearchPage["warning"];
      try {
        rows = searchMemory.all(boundedQuery, boundedLimit + 1) as unknown as MemoryMatchRow[];
      } catch {
        const fallback = literalFallbackQuery(boundedQuery);
        if (fallback.length === 0) {
          return { results: [], truncated: false, warning: "invalid_fts_query_fallback" };
        }
        rows = searchMemory.all(fallback, boundedLimit + 1) as unknown as MemoryMatchRow[];
        warning = "invalid_fts_query_fallback";
      }
      const truncated = rows.length > boundedLimit;
      const results = rows.slice(0, boundedLimit).map((row) => ({
        noteId: row.note_id,
        score: row.score,
        snippet: boundSnippet(row.snippet),
      }));
      return {
        results,
        truncated,
        ...(warning === undefined ? {} : { warning }),
      };
    },
    searchMemoryDocuments(request) {
      const boundedLimit = boundSearchLimit(request.limit);
      const boundedQuery = request.query.trim().slice(0, MAX_QUERY_LENGTH);
      if (boundedQuery.length === 0 || request.memoryView === "none") {
        return { results: [], truncated: false };
      }
      const where = [
        "memory_fts MATCH ?",
        request.memoryView === "household"
          ? "memory_document.scope = 'household'"
          : "(memory_document.scope = 'household' OR (memory_document.scope = 'personal' AND memory_document.owner = ?))",
      ];
      const filterArguments: Array<string | number> = [];
      if (request.memoryView === "owner-and-household") {
        filterArguments.push(request.principal);
      }
      if (request.types && request.types.length > 0) {
        where.push(`memory_document.type IN (${request.types.map(() => "?").join(", ")})`);
        filterArguments.push(...request.types);
      }
      if (request.statuses && request.statuses.length > 0) {
        where.push(`memory_document.status IN (${request.statuses.map(() => "?").join(", ")})`);
        filterArguments.push(...request.statuses);
      }
      const statement = db.prepare(`
        ${memoryDocumentSelect}
        WHERE ${where.join(" AND ")}
        ORDER BY score ASC, memory_document.updated_at DESC, memory_document.note_id ASC
        LIMIT ?
      `);
      let rows: MemoryDocumentMatchRow[];
      let warning: MemoryDocumentSearchPage["warning"];
      try {
        rows = statement.all(
          boundedQuery,
          ...filterArguments,
          boundedLimit + 1,
        ) as unknown as MemoryDocumentMatchRow[];
      } catch {
        const fallback = literalFallbackQuery(boundedQuery);
        if (fallback.length === 0) {
          return { results: [], truncated: false, warning: "invalid_fts_query_fallback" };
        }
        rows = statement.all(
          fallback,
          ...filterArguments,
          boundedLimit + 1,
        ) as unknown as MemoryDocumentMatchRow[];
        warning = "invalid_fts_query_fallback";
      }
      const truncated = rows.length > boundedLimit;
      const results = rows.slice(0, boundedLimit).map((row) => ({
        source: "memory" as const,
        schema: row.schema,
        id: row.note_id,
        relativePath: row.relative_path,
        type: row.type,
        status: row.status,
        scope: row.scope,
        ...(row.owner === null ? {} : { owner: row.owner }),
        title: row.title,
        tags: JSON.parse(row.tags_json) as string[],
        created: row.created_at,
        updated: row.updated_at,
        revision: row.revision,
        score: -row.score,
        snippet: boundSnippet(row.snippet),
      }));
      return {
        results,
        truncated,
        ...(warning === undefined ? {} : { warning }),
      };
    },
    replaceSessionDocuments(documents) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DELETE FROM session_document");
        for (const document of documents) {
          insertSession.run(
            document.instanceId,
            document.principalId,
            document.sessionId,
            document.entryId,
            document.timestamp,
            document.role,
            document.project,
            document.cwd,
            document.sourcePath,
            document.sourceOffset,
            document.searchableText,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    replaceSessionCorpus(instanceId, principalId, states, documents) {
      if (
        states.some(
          (state) => state.instanceId !== instanceId || state.principalId !== principalId,
        ) ||
        documents.some(
          (document) =>
            document.instanceId !== instanceId || document.principalId !== principalId,
        )
      ) {
        throw new Error("Session corpus replacement crossed its identity boundary");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        deleteSessionDocumentsForBoundary.run(instanceId, principalId);
        deleteSessionSourceStatesForBoundary.run(instanceId, principalId);
        insertSessionDocuments(documents);
        for (const state of states) saveSessionSourceState(state);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getSessionSourceState(instanceId, principalId, sourcePath) {
      const row = selectSessionSource.get(
        instanceId,
        principalId,
        sourcePath,
      ) as unknown as SessionSourceStateRow | undefined;
      return row === undefined ? undefined : mapSessionSourceState(row);
    },
    listSessionSourceStates(instanceId, principalId) {
      const rows = listSessionSources.all(
        instanceId,
        principalId,
      ) as unknown as SessionSourceStateRow[];
      return rows.map(mapSessionSourceState);
    },
    getSessionEntryIds(instanceId, principalId, sourcePath, beforeOffset = Number.MAX_SAFE_INTEGER) {
      const rows = selectSessionEntryIds.all(
        instanceId, principalId, sourcePath, beforeOffset,
        instanceId, principalId, sourcePath, beforeOffset,
      ) as unknown as EntryIdRow[];
      return new Set(rows.map((row) => row.entry_id));
    },
    getSessionDocument(instanceId, principalId, sessionId, entryId) {
      const row = selectSessionDocument.get(
        instanceId,
        principalId,
        sessionId,
        entryId,
      ) as unknown as SessionDocumentRow | undefined;
      if (row === undefined) return undefined;
      return {
        instanceId: row.instance_id,
        principalId: row.principal_id,
        sessionId: row.session_id,
        entryId: row.entry_id,
        timestamp: row.timestamp,
        role: row.role,
        project: row.project,
        cwd: row.cwd,
        sourcePath: row.source_path,
        sourceOffset: row.source_offset,
        searchableText: row.searchable_text,
      };
    },
    replaceSessionSource(state, documents, seenEntries = []) {
      db.exec("BEGIN IMMEDIATE");
      try {
        deleteSessionDocumentsForSource.run(
          state.instanceId,
          state.principalId,
          state.sourcePath,
        );
        deleteSeenEntries.run(state.instanceId, state.principalId, state.sourcePath);
        insertSessionDocuments(documents);
        saveSessionSourceState(state);
        saveSeenEntries(state, seenEntries);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    appendSessionSource(state, documents, seenEntries = []) {
      db.exec("BEGIN IMMEDIATE");
      try {
        insertSessionDocuments(documents);
        saveSessionSourceState(state);
        saveSeenEntries(state, seenEntries);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    deleteSessionSource(instanceId, principalId, sourcePath) {
      db.exec("BEGIN IMMEDIATE");
      try {
        deleteSessionDocumentsForSource.run(instanceId, principalId, sourcePath);
        deleteSessionSourceState.run(instanceId, principalId, sourcePath);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    recordCorpusAttempt(corpus, timestamp) {
      recordCorpusAttempt.run(corpus, timestamp);
    },
    recordCorpusSuccess(corpus, timestamp) {
      recordCorpusSuccess.run(corpus, timestamp);
    },
    corpusStatuses() {
      const statuses: Record<SearchCorpus, CorpusOperationStatus> = {
        memory: { lastAttemptAt: null, lastSuccessAt: null },
        session: { lastAttemptAt: null, lastSuccessAt: null },
      };
      const rows = selectCorpusStatuses.all() as unknown as CorpusStatusRow[];
      for (const row of rows) {
        statuses[row.corpus] = {
          lastAttemptAt: row.last_attempt_at,
          lastSuccessAt: row.last_success_at,
        };
      }
      return statuses;
    },
    searchSessions(query, limit) {
      const boundedLimit = boundSearchLimit(limit);
      const boundedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
      if (boundedQuery.length === 0) return { results: [], truncated: false };

      let rows: SessionMatchRow[];
      let warning: SessionSearchPage["warning"];
      try {
        rows = searchSessions.all(boundedQuery, boundedLimit + 1) as unknown as SessionMatchRow[];
      } catch {
        const fallback = literalFallbackQuery(boundedQuery);
        if (fallback.length === 0) {
          return { results: [], truncated: false, warning: "invalid_fts_query_fallback" };
        }
        rows = searchSessions.all(fallback, boundedLimit + 1) as unknown as SessionMatchRow[];
        warning = "invalid_fts_query_fallback";
      }
      const truncated = rows.length > boundedLimit;
      const results = rows.slice(0, boundedLimit).map((row) => ({
        instanceId: row.instance_id,
        principalId: row.principal_id,
        sessionId: row.session_id,
        entryId: row.entry_id,
        timestamp: row.timestamp,
        role: row.role,
        project: row.project,
        sourcePath: row.source_path,
        sourceOffset: row.source_offset,
        score: row.score,
        snippet: boundSnippet(row.snippet),
      }));
      return {
        results,
        truncated,
        ...(warning === undefined ? {} : { warning }),
      };
    },
    searchSessionDocuments(request) {
      const boundedLimit = boundSearchLimit(request.limit);
      const boundedQuery = request.query.trim().slice(0, MAX_QUERY_LENGTH);
      if (boundedQuery.length === 0) return { results: [], truncated: false };
      const where = [
        "session_fts MATCH ?",
        "session_document.instance_id = ?",
        "session_document.principal_id = ?",
      ];
      const filterArguments: Array<string | number> = [
        request.instanceId,
        request.principalId,
      ];
      if (request.roles && request.roles.length > 0) {
        where.push(`session_document.role IN (${request.roles.map(() => "?").join(", ")})`);
        filterArguments.push(...request.roles);
      }
      if (request.from) {
        where.push("session_document.timestamp >= ?");
        filterArguments.push(request.from);
      }
      if (request.to) {
        where.push("session_document.timestamp <= ?");
        filterArguments.push(request.to);
      }
      if (request.project) {
        where.push("session_document.project = ?");
        filterArguments.push(request.project);
      }
      const statement = db.prepare(`
        ${sessionDocumentSelect}
        WHERE ${where.join(" AND ")}
        ORDER BY score ASC, session_document.timestamp DESC,
          session_document.session_id ASC, session_document.entry_id ASC
        LIMIT ?
      `);
      let rows: SessionMatchRow[];
      let warning: SessionDocumentSearchPage["warning"];
      try {
        rows = statement.all(
          boundedQuery,
          ...filterArguments,
          boundedLimit + 1,
        ) as unknown as SessionMatchRow[];
      } catch {
        const fallback = literalFallbackQuery(boundedQuery);
        if (fallback.length === 0) {
          return { results: [], truncated: false, warning: "invalid_fts_query_fallback" };
        }
        rows = statement.all(
          fallback,
          ...filterArguments,
          boundedLimit + 1,
        ) as unknown as SessionMatchRow[];
        warning = "invalid_fts_query_fallback";
      }
      const truncated = rows.length > boundedLimit;
      const results = rows.slice(0, boundedLimit).map((row) => ({
        source: "session" as const,
        sessionId: row.session_id,
        entryId: row.entry_id,
        timestamp: row.timestamp,
        role: row.role,
        ...(row.project === null ? {} : { project: row.project }),
        sourcePath: row.source_path,
        sourceOffset: row.source_offset,
        score: -row.score,
        snippet: boundSnippet(row.snippet),
      }));
      return {
        results,
        truncated,
        ...(warning === undefined ? {} : { warning }),
      };
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
