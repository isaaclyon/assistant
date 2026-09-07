import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AtJob, JobDefinition } from "./jobs.js";

export interface JobOccurrence {
  id: string;
  jobId: string;
  jobType: JobDefinition["type"];
  target?: string;
  definitionFingerprint: string;
  eventId: string;
  prompt: string;
  createdAt: number;
  status: "pending" | "published" | "superseded";
}

export interface JobOccurrenceLedger {
  reconcileDefinitions(jobs: readonly JobDefinition[], legacyFired: Record<string, number>): string[];
  materialize(job: JobDefinition, eventId: string, prompt: string, createdAt: number): JobOccurrence;
  pending(): JobOccurrence[];
  superseded(): JobOccurrence[];
  markPublished(id: string): void;
  oneShotPublished(job: AtJob): boolean;
  close(): void;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function definitionFingerprint(job: JobDefinition): string {
  const normalized = job.type === "at" ? { ...job, at: new Date(job.at).toISOString() } : job;
  return createHash("sha256").update(stableJson(normalized)).digest("hex");
}

function parseOccurrence(row: Record<string, unknown>): JobOccurrence {
  const string = (key: string): string => {
    if (typeof row[key] !== "string") throw new Error("Invalid occurrence field");
    return row[key];
  };
  const jobType = string("job_type");
  const status = string("status");
  if (!["cron", "at", "heartbeat", "webhook"].includes(jobType) ||
      !["pending", "published", "superseded"].includes(status) ||
      (row.target !== null && typeof row.target !== "string") ||
      typeof row.created_at !== "number" || !Number.isSafeInteger(row.created_at)) {
    throw new Error("Invalid occurrence state");
  }
  return {
    id: string("id"), jobId: string("job_id"), jobType: jobType as JobDefinition["type"],
    ...(row.target === null ? {} : { target: row.target as string }),
    definitionFingerprint: string("definition_fingerprint"), eventId: string("event_id"),
    prompt: string("prompt"), createdAt: row.created_at, status: status as JobOccurrence["status"],
  };
}

export function openJobOccurrenceLedger(stateDir: string, options: { offlineLegacyInitialization?: boolean } = {}): JobOccurrenceLedger {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const root = lstatSync(stateDir);
  if (!root.isDirectory() || (root.mode & 0o777) !== 0o700 ||
      (process.getuid && root.uid !== process.getuid())) {
    throw new Error("Job ledger requires a private, owned directory");
  }
  const path = join(stateDir, "job-occurrences.db");
  const exists = (name: string): boolean => {
    try { lstatSync(join(stateDir, name)); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const legacyState = ["jobs-state.json", "job-dispatches", "job-handoffs"].some(exists);
  if (legacyState && !exists("job-occurrences.db") && !options.offlineLegacyInitialization) {
    throw new Error("Legacy job state requires offline migration before scheduler startup");
  }
  try { closeSync(openSync(path, "wx", 0o600)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 ||
      (process.getuid && metadata.uid !== process.getuid())) {
    throw new Error("Job ledger must be a private, owned regular file");
  }
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    db.exec(`
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS ledger_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL,
        definitions_initialized INTEGER NOT NULL CHECK (definitions_initialized IN (0, 1))
      ) STRICT;
      INSERT OR IGNORE INTO ledger_metadata VALUES (1, 1, 0);
    `);
    if (db.prepare("SELECT version FROM ledger_metadata").get()?.version !== 1) {
      throw new Error("Unsupported job occurrence ledger version");
    }
    if (legacyState && !options.offlineLegacyInitialization &&
        db.prepare("SELECT definitions_initialized FROM ledger_metadata").get()?.definitions_initialized !== 1) {
      throw new Error("Interrupted legacy job initialization requires offline migration");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS current_definition (
        job_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        legacy_fired INTEGER NOT NULL CHECK (legacy_fired IN (0, 1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS occurrence (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        job_type TEXT NOT NULL CHECK (job_type IN ('cron', 'at', 'heartbeat', 'webhook')),
        target TEXT,
        definition_fingerprint TEXT NOT NULL,
        event_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'superseded')),
        UNIQUE (job_id, definition_fingerprint, event_id)
      ) STRICT;
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  const transaction = <T>(operation: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const current = db.prepare("SELECT fingerprint, legacy_fired FROM current_definition WHERE job_id = ?");
  const list = (status: JobOccurrence["status"]): JobOccurrence[] =>
    db.prepare("SELECT * FROM occurrence WHERE status = ? ORDER BY created_at, id").all(status).map(parseOccurrence);
  let closed = false;
  return {
    reconcileDefinitions(jobs, legacyFired) {
      return transaction(() => {
        const initialize = db.prepare("SELECT definitions_initialized FROM ledger_metadata").get()?.definitions_initialized === 0;
        const changed: string[] = [];
        const ids = new Set(jobs.map((job) => job.id));
        for (const row of db.prepare("SELECT job_id FROM current_definition").all()) {
          if (!ids.has(String(row.job_id))) {
            db.prepare("DELETE FROM current_definition WHERE job_id = ?").run(row.job_id!);
            changed.push(String(row.job_id));
          }
        }
        for (const job of jobs) {
          const fingerprint = definitionFingerprint(job);
          if (current.get(job.id)?.fingerprint === fingerprint) continue;
          changed.push(job.id);
          db.prepare(`INSERT INTO current_definition VALUES (?, ?, ?)
            ON CONFLICT (job_id) DO UPDATE SET fingerprint = excluded.fingerprint, legacy_fired = excluded.legacy_fired`)
            .run(job.id, fingerprint, initialize && job.type === "at" && legacyFired[job.id] !== undefined ? 1 : 0);
        }
        db.exec(`UPDATE occurrence SET status = 'superseded'
          WHERE NOT EXISTS (SELECT 1 FROM current_definition d
            WHERE d.job_id = occurrence.job_id AND d.fingerprint = occurrence.definition_fingerprint);
          UPDATE ledger_metadata SET definitions_initialized = 1;`);
        return changed;
      });
    },
    materialize(job, eventId, prompt, createdAt) {
      if (!eventId || eventId.length > 1024 || !prompt.trim() ||
          Buffer.byteLength(prompt, "utf8") > 32 * 1024 || !Number.isSafeInteger(createdAt)) {
        throw new Error("Invalid occurrence input");
      }
      const fingerprint = definitionFingerprint(job);
      const id = `${job.id}-${createHash("sha256").update(JSON.stringify([job.id, fingerprint, eventId])).digest("hex")}`;
      return transaction(() => {
        if (current.get(job.id)?.fingerprint !== fingerprint) throw new Error("Job definition is no longer current");
        db.prepare("INSERT OR IGNORE INTO occurrence VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')")
          .run(id, job.id, job.type, job.target ?? null, fingerprint, eventId, prompt, createdAt);
        const saved = parseOccurrence(db.prepare("SELECT * FROM occurrence WHERE id = ?").get(id)!);
        if (saved.prompt !== prompt || saved.target !== job.target) throw new Error("Occurrence identity collision");
        return saved;
      });
    },
    pending: () => list("pending"),
    superseded: () => list("superseded"),
    markPublished(id) {
      db.prepare("UPDATE occurrence SET status = 'published' WHERE id = ? AND status = 'pending'").run(id);
    },
    oneShotPublished(job) {
      const fingerprint = definitionFingerprint(job);
      const definition = current.get(job.id);
      if (definition?.fingerprint !== fingerprint) return false;
      return definition.legacy_fired === 1 || db.prepare(`SELECT 1 FROM occurrence
        WHERE job_id = ? AND definition_fingerprint = ? AND status = 'published' LIMIT 1`).get(job.id, fingerprint) !== undefined;
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
