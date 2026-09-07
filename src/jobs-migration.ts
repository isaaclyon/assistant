import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { JobDefinition } from "./jobs.js";
import { openJobOccurrenceLedger } from "./job-occurrences.js";

const states = ["pending", "processing", "completed", "failed", "acknowledged", "cancelled"] as const;
const slug = /^[a-z0-9-]{1,64}$/;
const hash = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// JSON.parse silently accepts duplicate object keys. Migration evidence must not.
export function parseMigrationJson(raw: string): unknown {
  const result: unknown = JSON.parse(raw);
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const key: string = JSON.parse(token);
      const keys = stack.at(-1)!;
      if (keys.has(key)) throw new Error("Duplicate migration JSON key");
      keys.add(key);
    }
  }
  return result;
}

async function directory(path: string, optional = false): Promise<string[]> {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) {
    throw new Error("Migration requires private owned directories without symlinks");
  }
  const entries = await readdir(path);
  if (entries.length > 10_000) throw new Error("Migration inventory limit exceeded");
  return entries.sort();
}

export async function readMigrationJson(path: string): Promise<{ value: unknown; digest: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) {
      throw new Error("Migration requires bounded private owned regular files");
    }
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size !== info.size) throw new Error("Migration evidence changed during inspection");
    const bytes = buffer.subarray(0, size);
    return { value: parseMigrationJson(bytes.toString("utf8")), digest: createHash("sha256").update(bytes).digest("hex") };
  } finally { await file.close(); }
}

interface Dispatch {
  id: string; eventHash: string; jobId: string; target: string; recipients: string[]; createdAt: string;
}
interface Evidence { prompt?: string; jobType?: string }

/** Offline only: callers must stop every writer before inspection and keep them stopped. */
export async function inspectLegacyJobMigration(options: {
  coordinatorStateDir: string;
  recipients: Record<string, string>;
  jobs?: readonly JobDefinition[];
}): Promise<{ dispatches: number; recipientFiles: number; digest: string; suppressAt: string[] }> {
  const roots = [options.coordinatorStateDir, ...Object.values(options.recipients)];
  if (roots.some((root) => !isAbsolute(root)) || Object.keys(options.recipients).some((id) => !slug.test(id)) ||
      new Set(Object.values(options.recipients).map((root) => resolve(root))).size !== Object.keys(options.recipients).length) {
    throw new Error("Invalid migration root mapping");
  }
  for (const root of new Set(roots)) await directory(root);
  const digests: string[] = [];
  let fileCount = 0;
  const read = async (path: string): Promise<unknown> => {
    if (++fileCount > 10_000) throw new Error("Migration inventory limit exceeded");
    const { value, digest } = await readMigrationJson(path);
    digests.push(`${path}:${digest}`);
    return value;
  };
  const dispatches = new Map<string, Dispatch>();
  const dispatchDir = join(options.coordinatorStateDir, "job-dispatches");
  for (const name of await directory(dispatchDir, true)) {
    if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error("Unknown dispatch artifact");
    const value = await read(join(dispatchDir, name));
    if (!record(value) || value.version !== 1 || typeof value.jobId !== "string" || !slug.test(value.jobId) ||
        typeof value.eventHash !== "string" || !hash.test(value.eventHash) ||
        value.dispatchId !== `${value.jobId}-${value.eventHash.slice(0, 16)}` || name !== `${value.dispatchId}.json` ||
        typeof value.target !== "string" || !slug.test(value.target) || !record(value.recipients) ||
        typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
      throw new Error("Malformed legacy dispatch identity");
    }
    const recipients = value.target === "both-personal" ? ["emma", "isaac"] : [value.target];
    if (Object.keys(value.recipients).sort().join(",") !== recipients.join(",") ||
        recipients.some((id) => !Object.hasOwn(options.recipients, id)) ||
        Object.values(value.recipients).some((status) => status !== "enqueued")) {
      throw new Error("Unresolved or unknown dispatch recipients");
    }
    dispatches.set(String(value.dispatchId), { id: String(value.dispatchId), jobId: value.jobId,
      eventHash: value.eventHash, target: value.target, recipients, createdAt: value.createdAt });
  }
  const evidence = new Map<string, Map<string, Evidence>>();
  let recipientFiles = 0;
  for (const [recipient, root] of Object.entries(options.recipients).sort()) {
    const handoffRoot = join(root, "job-handoffs");
    for (const state of await directory(handoffRoot, true)) {
      // Known lock databases are not handoff evidence; they must still be safe files.
      if (/^\.(?:transition|drain)-lock\.sqlite(?:-journal)?$/.test(state)) {
        const info = await lstat(join(handoffRoot, state));
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) {
          throw new Error("Unsafe migration lock file");
        }
        continue;
      }
      if (!(states as readonly string[]).includes(state)) throw new Error("Unknown recipient directory");
      for (const name of await directory(join(handoffRoot, state))) {
        if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error("Unknown recipient artifact");
        if (["pending", "processing", "failed"].includes(state)) throw new Error("Unresolved legacy recipient work; operator resolution required");
        const value = await read(join(handoffRoot, state, name));
        if (!record(value) || value.version !== 1 || typeof value.dispatchId !== "string" ||
            name !== `${value.dispatchId}.json` || value.target !== recipient) throw new Error("Malformed recipient identity");
        const dispatch = dispatches.get(value.dispatchId);
        if (!dispatch) throw new Error("Orphan recipient evidence");
        if (dispatch.jobId !== value.jobId || !dispatch.recipients.includes(recipient)) throw new Error("Recipient identity mismatch");
        const tombstone = state === "cancelled" && value.prompt === undefined;
        if (!tombstone && (typeof value.prompt !== "string" || !value.prompt.trim() ||
            Buffer.byteLength(value.prompt) > 32 * 1024 || value.createdAt !== dispatch.createdAt ||
            (value.jobType !== undefined && !["cron", "at", "heartbeat", "webhook"].includes(String(value.jobType))))) {
          throw new Error("Malformed recipient payload");
        }
        const siblings = evidence.get(dispatch.id) ?? new Map<string, Evidence>();
        if (siblings.has(recipient)) throw new Error("Conflicting recipient evidence");
        const entry: Evidence = tombstone ? {} : { prompt: value.prompt as string,
          ...(value.jobType === undefined ? {} : { jobType: String(value.jobType) }) };
        for (const sibling of siblings.values()) {
          if (sibling.prompt !== undefined && entry.prompt !== undefined &&
              (sibling.prompt !== entry.prompt || sibling.jobType !== entry.jobType)) throw new Error("Conflicting sibling payload");
        }
        siblings.set(recipient, entry); evidence.set(dispatch.id, siblings); recipientFiles++;
      }
    }
  }
  const suppressAt = new Set<string>();
  for (const dispatch of dispatches.values()) {
    const siblings = evidence.get(dispatch.id);
    if (!siblings || siblings.size !== dispatch.recipients.length) throw new Error("Missing recipient evidence");
    const job = options.jobs?.find((job) => job.id === dispatch.jobId && job.type === "at");
    if (!job || job.type !== "at") continue;
    // Only suppress the exact current one-shot. Never synthesize an occurrence.
    const eventHash = createHash("sha256").update(`at:${job.id}:${Date.parse(job.at)}`).digest("hex");
    if (eventHash !== dispatch.eventHash) continue;
    const prompt = `One-time reminder '${job.id}' fired (scheduled for ${job.at}).\n\n${job.prompt}`;
    const payloads = [...siblings.values()].filter((value) => value.prompt !== undefined);
    if (dispatch.target !== (job.target ?? "local") || !payloads.length ||
        payloads.some((value) => value.jobType !== "at" || value.prompt !== prompt)) {
      throw new Error("Cannot prove current one-shot legacy identity; operator resolution required");
    }
    suppressAt.add(job.id);
  }
  return { dispatches: dispatches.size, recipientFiles,
    digest: createHash("sha256").update(digests.sort().join("\n")).digest("hex"), suppressAt: [...suppressAt].sort() };
}

/** One-time suppression migration, not occurrence reconstruction. Requires quiescent writers. */
export async function initializeLegacyJobLedger(options: {
  coordinatorStateDir: string; recipients: Record<string, string>; jobs: readonly JobDefinition[];
}): Promise<Awaited<ReturnType<typeof inspectLegacyJobMigration>>> {
  try {
    await lstat(join(options.coordinatorStateDir, "job-occurrences.db"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const report = await inspectLegacyJobMigration(options);
    let fired: Record<string, number> = {};
    try {
      const { value } = await readMigrationJson(join(options.coordinatorStateDir, "jobs-state.json"));
      if (!record(value) || !record(value.fired) || !record(value.lastRun) ||
          [...Object.entries(value.fired), ...Object.entries(value.lastRun)].some(([id, time]) =>
            !slug.test(id) || typeof time !== "number" || !Number.isSafeInteger(time) || time < 0)) {
        throw new Error("Invalid legacy scheduler state");
      }
      fired = value.fired as Record<string, number>;
    } catch (stateError) {
      if ((stateError as NodeJS.ErrnoException).code !== "ENOENT" || report.dispatches !== 0) throw stateError;
    }
    for (const job of options.jobs) {
      if (job.type === "at" && Object.hasOwn(fired, job.id) && !report.suppressAt.includes(job.id)) {
        throw new Error("Cannot prove legacy fired ID belongs to the current one-shot; operator resolution required");
      }
    }
    const suppression = Object.fromEntries(report.suppressAt.map((id) => [id, 0]));
    const ledger = openJobOccurrenceLedger(options.coordinatorStateDir, { offlineLegacyInitialization: true });
    try { ledger.reconcileDefinitions(options.jobs, suppression); } finally { ledger.close(); }
    return report;
  }
  throw new Error("Occurrence ledger already exists; inspect or restore interrupted migration before retrying");
}
