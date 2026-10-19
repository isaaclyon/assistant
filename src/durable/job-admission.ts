import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineDoc, type ConversationId, type SubmissionId } from '@earendil-works/pi-durable';
import { withMutationLock } from '../../.pi/lib/mutation-lock.mjs';
import { MAX_HANDOFF_FILE_BYTES, MAX_HANDOFF_PROMPT_BYTES, moveHandoff, writeJsonAtomic } from '../job-handoff.js';
import { Bindings, accept, admit, context, fingerprint, sourceKey, type IngressRuntime, type SourceEnvelope, type Target } from './ingress.js';

const MAX_FILE_BYTES = MAX_HANDOFF_FILE_BYTES;
const MAX_ATTEMPTS = 5;
const MAX_SCAN_FILES = 100;
const KEYS = new Set(['version', 'dispatchId', 'jobId', 'jobType', 'target', 'prompt', 'createdAt', 'attempts']);
type Handoff = { dispatchId: string; jobId: string; jobType?: 'cron' | 'at' | 'heartbeat' | 'webhook'; target: string; prompt: string; createdAt: string; attempts: number };

/** Native receipts for v1 job handoffs. `admission` is the only thing the v1 `completed/` directory means;
 * `run` tracks the native run separately and never moves files. */
export type JobAdmission = {
  fingerprint: string; sourceKey: string; requestId: string; cid: ConversationId | null;
  admission: 'reserved' | 'admitted' | 'cancelled'; submissionId?: SubmissionId;
  run: 'pending' | 'done' | 'unanswered';
};
type JobAdmissionState = {
  receipts: Record<string, JobAdmission>;
  /** Fair receipt cursors, absent until a scan exceeds its lookup budget. */
  runCursor?: string; cancelCursor?: string;
};
export const JobAdmissions = defineDoc({ kind: 'bridge.job-admissions', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: (): JobAdmissionState => ({ receipts: {} }) });

export interface JobHandoffReconcileOptions {
  runtime: IngressRuntime; stateDir: string; instanceId: string; principal: string; bot: string; target: Target;
  policy: (envelope: SourceEnvelope) => void | Promise<void>;
  onConversation?: (cid: ConversationId) => Promise<void>;
}
export interface JobHandoffReconcileResult {
  admitted: number; resumed: number; cancelled: number; runsSettled: number;
  /** Files moved to failed/, as `name: reason`. */
  quarantined: string[];
  /** Evidence left in place on purpose, as `name: reason`. */
  held: string[];
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(raw: string): Handoff | string {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return 'malformed JSON'; }
  if (!isRecord(v) || v.version !== 1 || Object.keys(v).some(k => !KEYS.has(k))) return 'unknown shape';
  const { dispatchId, jobId, jobType, target, prompt, createdAt, attempts } = v;
  if (typeof dispatchId !== 'string' || typeof jobId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(jobId) ||
      !new RegExp(`^${jobId}-[a-f0-9]{16}(?:[a-f0-9]{48})?$`).test(dispatchId)) return 'invalid identity';
  if (jobType !== undefined && !['cron', 'at', 'heartbeat', 'webhook'].includes(String(jobType))) return 'invalid job type';
  if (typeof target !== 'string' || !/^[a-z0-9-]{1,64}$/.test(target)) return 'invalid target';
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_HANDOFF_PROMPT_BYTES) return 'invalid prompt';
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < 0 || new Date(createdAt).toISOString() !== createdAt) return 'invalid createdAt';
  if (attempts !== undefined && (!Number.isSafeInteger(attempts) || (attempts as number) < 0 || (attempts as number) > MAX_ATTEMPTS)) return 'invalid attempts';
  return { dispatchId, jobId, ...(jobType === undefined ? {} : { jobType: jobType as Handoff['jobType'] }), target, prompt, createdAt, attempts: (attempts as number | undefined) ?? 0 };
}

type Read = { kind: 'ok'; raw: string } | { kind: 'unsafe'; reason: string };
async function readSafe(path: string): Promise<Read> {
  const meta = await lstat(path);
  if (!meta.isFile()) return { kind: 'unsafe', reason: 'not a regular file' };
  if (meta.nlink !== 1) return { kind: 'unsafe', reason: 'hard-linked file' };
  if ((meta.mode & 0o777) !== 0o600) return { kind: 'unsafe', reason: 'mode is not 0600' };
  if (process.getuid && meta.uid !== process.getuid()) return { kind: 'unsafe', reason: 'foreign owner' };
  if (meta.size > MAX_FILE_BYTES) return { kind: 'unsafe', reason: 'oversized' };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = await handle.stat();
    if (after.ino !== meta.ino || after.dev !== meta.dev || after.size !== meta.size) return { kind: 'unsafe', reason: 'changed while reading' };
    const bytes = Buffer.alloc(after.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === after.size ? { kind: 'ok', raw: bytes.toString('utf8') } : { kind: 'unsafe', reason: 'changed while reading' };
  } finally { await handle.close(); }
}

async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if (errno(error) === 'ENOENT') return false; throw error; }
}

async function ensureDirectory(path: string): Promise<string | undefined> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (errno(error) !== 'EEXIST') throw error; }
  const meta = await lstat(path);
  if (!meta.isDirectory()) return `${path} is not a real directory`;
  if (process.getuid && meta.uid !== process.getuid()) return `${path} has a foreign owner`;
  if ((meta.mode & 0o777) !== 0o700) return `${path} is not private (0700)`;
  return undefined;
}

export function jobEnvelope(handoff: Pick<Handoff, 'dispatchId' | 'jobId' | 'jobType' | 'prompt' | 'createdAt'>, o: Pick<JobHandoffReconcileOptions, 'instanceId' | 'principal' | 'bot' | 'target'>): SourceEnvelope {
  const envelope = {
    instance: o.instanceId, principal: o.principal, bot: o.bot, chatId: o.target.chatId,
    ...(o.target.threadId === undefined ? {} : { threadId: o.target.threadId }),
    messageIds: [] as number[], originalAt: Date.parse(handoff.createdAt), content: handoff.prompt, proactive: true, attachments: [],
    job: { dispatchId: handoff.dispatchId, jobId: handoff.jobId, ...(handoff.jobType === undefined ? {} : { jobType: handoff.jobType }), createdAt: handoff.createdAt },
  };
  return envelope as SourceEnvelope;
}

/** Runs on the serialized host line, before inbox admission. Recipient protocol is the v1 layout,
 * under the same drain lock (outer) and transition lock (inner) as the legacy drain, cancel and recovery. */
export async function reconcileJobHandoffs(options: JobHandoffReconcileOptions): Promise<JobHandoffReconcileResult> {
  const result: JobHandoffReconcileResult = { admitted: 0, resumed: 0, cancelled: 0, runsSettled: 0, quarantined: [], held: [] };
  const root = join(options.stateDir, 'job-handoffs');
  const { runtime } = options;
  const problems: string[] = [];
  for (const path of [root, ...['pending', 'processing', 'completed', 'failed', 'cancelled', 'acknowledged'].map(d => join(root, d))]) {
    const problem = await ensureDirectory(path);
    if (problem) problems.push(problem);
    if (problem && path === root) break;
  }
  if (problems.length) { result.held.push(...problems.map(p => `job-handoffs: ${p}`)); return result; }
  const transition = <T>(operation: () => Promise<T>) => withMutationLock(join(root, '.transition-lock.sqlite'), operation);
  const receipts = async () => (await runtime.harness.snapshot(JobAdmissions, runtime.root.id, context))?.receipts ?? {};

  const quarantine = async (dir: string, name: string, reason: string) => {
    let destination = join(root, 'failed', name);
    if (await exists(destination)) destination = `${destination}.conflict-${randomUUID()}`;
    await moveHandoff(join(root, dir, name), destination);
    result.quarantined.push(`${name}: ${reason}`);
  };
  const setReceipt = (dispatchId: string, change: (r: JobAdmission) => void) =>
    runtime.root.commit(async tx => { change((await tx.doc(JobAdmissions, runtime.root.id)).receipts[dispatchId]!); }, context);
  const receiptBatch = async (field: 'runCursor' | 'cancelCursor', include: (r: JobAdmission) => boolean) => {
    const doc = await runtime.harness.snapshot(JobAdmissions, runtime.root.id, context);
    const candidates = Object.entries(doc?.receipts ?? {}).filter(([, r]) => include(r)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const cursor = doc?.[field];
    const start = cursor === undefined ? 0 : candidates.findIndex(([id]) => id > cursor);
    const ordered = start <= 0 ? candidates : [...candidates.slice(start), ...candidates.slice(0, start)];
    const batch = ordered.slice(0, MAX_SCAN_FILES);
    if (candidates.length > MAX_SCAN_FILES) {
      const next = batch[batch.length - 1]![0];
      if (next !== cursor) await runtime.root.commit(async tx => { (await tx.doc(JobAdmissions, runtime.root.id))[field] = next; }, context);
    }
    return batch;
  };

  /** Validates one file in `dir`. Returns undefined after quarantine/hold. */
  const inspect = async (dir: 'pending' | 'processing', name: string) => {
    const path = join(root, dir, name);
    let read: Read;
    try { read = await readSafe(path); } catch (error) { if (errno(error) === 'ENOENT') return undefined; if (errno(error) === 'ELOOP') read = { kind: 'unsafe', reason: 'symlink' }; else throw error; }
    if (read.kind === 'unsafe') { await quarantine(dir, name, read.reason); return undefined; }
    const handoff = parse(read.raw);
    if (typeof handoff === 'string') { await quarantine(dir, name, handoff); return undefined; }
    if (name !== `${handoff.dispatchId}.json`) { await quarantine(dir, name, 'filename does not match dispatch'); return undefined; }
    if (handoff.target !== options.instanceId) { await quarantine(dir, name, 'recipient mismatch'); return undefined; }
    if (dir === 'pending' && handoff.attempts >= MAX_ATTEMPTS) { await quarantine(dir, name, 'attempts exhausted'); return undefined; }
    const envelope = jobEnvelope(handoff, options), fp = fingerprint(envelope), key = sourceKey(envelope);
    const receipt = (await receipts())[handoff.dispatchId];
    const binding = (await runtime.harness.snapshot(Bindings, runtime.root.id, context))?.sources[key];
    if ((receipt && (receipt.fingerprint !== fp || receipt.sourceKey !== key)) || (binding && binding.fingerprint !== fp)) {
      await quarantine(dir, name, 'conflicting payload for dispatch'); return undefined;
    }
    try { await options.policy(envelope); } catch (error) { await quarantine(dir, name, `policy rejected: ${(error as Error).message}`); return undefined; }
    return { handoff, envelope, fp, key, receipt };
  };

  /** Binds the receipt, accepts into the stable source, submits, then records admission before the v1 move. */
  const finish = async (name: string, envelope: SourceEnvelope, dispatchId: string) => {
    const accepted = await accept(runtime, envelope);
    await setReceipt(dispatchId, r => { if (r.cid !== null && r.cid !== accepted.binding.conversationId) throw new Error('Job receipt conversation mismatch'); r.cid = accepted.binding.conversationId; });
    await options.onConversation?.(accepted.binding.conversationId);
    const submission = await admit(runtime, envelope);
    if (!submission) {
      await setReceipt(dispatchId, r => { r.admission = 'cancelled'; });
      await moveHandoff(join(root, 'processing', name), join(root, 'cancelled', name));
      result.cancelled += 1; return;
    }
    await setReceipt(dispatchId, r => { r.admission = 'admitted'; r.submissionId = submission.id; });
    await moveHandoff(join(root, 'processing', name), join(root, 'completed', name));
  };

  const body = async () => {
    // Native-owned survivors first, so a lost submit receipt or lost move is resumed from the exact reservation.
    const known = await receipts();
    const processing = (await readdir(join(root, 'processing'))).filter(n => n.endsWith('.json')).sort((a,b) => Number(!!known[b.slice(0,-5)])-Number(!!known[a.slice(0,-5)]) || a.localeCompare(b));
    if (processing.length > MAX_SCAN_FILES) result.held.push('processing: scan limit reached; remaining claims held');
    for (const name of processing.slice(0, MAX_SCAN_FILES)) {
      await transition(async () => {
        const checked = await inspect('processing', name);
        if (!checked) return;
        if (!checked.receipt) {
          // No native reservation: legacy or unknown claim. Do not guess a replay.
          result.held.push(`${name}: processing without native reservation`); return;
        }
        await finish(name, checked.envelope, checked.handoff.dispatchId);
        result.resumed += 1;
      });
    }
    const pending = (await readdir(join(root, 'pending'))).filter(n => n.endsWith('.json')).sort();
    if (pending.length > MAX_SCAN_FILES) result.held.push('pending: scan limit reached; remaining work waits');
    for (const name of pending.slice(0, MAX_SCAN_FILES)) {
      await transition(async () => {
        const checked = await inspect('pending', name);
        if (!checked) return;
        const { handoff, envelope, fp, key } = checked;
        for (const state of ['processing', 'completed', 'acknowledged', 'failed', 'cancelled']) {
          if (await exists(join(root, state, name))) { await quarantine('pending', name, `duplicate of ${state}`); return; }
        }
        // Reservation precedes the claim so a surviving claim is provably native-owned.
        await runtime.root.commit(async tx => {
          const doc = await tx.doc(JobAdmissions, runtime.root.id);
          doc.receipts[handoff.dispatchId] ??= { fingerprint: fp, sourceKey: key, requestId: key, cid: null, admission: 'reserved', run: 'pending' };
        }, context);
        await writeJsonAtomic(join(root, 'pending', name), { version: 1, dispatchId: handoff.dispatchId, jobId: handoff.jobId, ...(handoff.jobType === undefined ? {} : { jobType: handoff.jobType }), target: handoff.target, prompt: handoff.prompt, createdAt: handoff.createdAt, attempts: handoff.attempts + 1 });
        await moveHandoff(join(root, 'pending', name), join(root, 'processing', name));
        await finish(name, envelope, handoff.dispatchId);
        result.admitted += 1;
      });
    }
    // A reserved receipt whose claim never happened can be cancelled by the legacy coordinator. Only a cancelled
    // file that parses as the same payload (same fingerprint and source key) settles it; a bare tombstone is held.
    for (const [id, receipt] of await receiptBatch('cancelCursor', r => r.admission === 'reserved' && r.cid === null)) {
      await transition(async () => {
        const name = `${id}.json`;
        for (const state of ['pending', 'processing', 'completed', 'acknowledged', 'failed']) if (await exists(join(root, state, name))) return;
        let read: Read;
        try { read = await readSafe(join(root, 'cancelled', name)); } catch (error) { if (errno(error) === 'ENOENT' || errno(error) === 'ELOOP') return; throw error; }
        if (read.kind !== 'ok') return;
        const handoff = parse(read.raw);
        if (typeof handoff === 'string' || handoff.dispatchId !== id || handoff.target !== options.instanceId) return;
        const envelope = jobEnvelope(handoff, options);
        if (fingerprint(envelope) !== receipt.fingerprint || sourceKey(envelope) !== receipt.sourceKey) return;
        await setReceipt(id, r => { if (r.admission === 'reserved' && r.cid === null) r.admission = 'cancelled'; });
        result.cancelled += 1;
      });
    }
    // Run completion is recorded in the document only; v1 directories are not touched. At most
    // MAX_SCAN_FILES submission lookups per pass, resuming after the last id examined so old unsettled runs cannot starve newer ones.
    for (const [id, receipt] of await receiptBatch('runCursor', r => r.admission === 'admitted' && r.run === 'pending' && r.cid !== null)) {
      const submission = await runtime.root.commit(tx => tx.submissionByRequest(receipt.cid!, receipt.requestId), context);
      if (!submission || submission.type !== 'input' || (submission.status !== 'done' && submission.status !== 'unanswered')) continue;
      await setReceipt(id, r => { r.run = submission.status as 'done' | 'unanswered'; });
      result.runsSettled += 1;
    }
  };
  try {
    await withMutationLock(join(root, '.drain-lock.sqlite'), body);
  } catch (error) {
    if ((error as { code?: string }).code !== 'MUTATION_BUSY') throw error;
    result.held.push('job-handoffs: another drain, cancel or recovery holds the lock');
  }
  return result;
}

/** Read-only operator projection. Counts only; it never claims files, admits work or exposes prompts/targets. */
export async function inspectJobHandoffs(options: Pick<JobHandoffReconcileOptions, 'runtime' | 'stateDir'>) {
  const receipts = (await options.runtime.harness.snapshot(JobAdmissions, options.runtime.root.id, context))?.receipts ?? {};
  const files: Record<string, number> = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, acknowledged: 0 };
  const status = { files, heldClaims: 0, unsafeTree: false, admissions: { reserved: 0, admitted: 0, cancelled: 0 }, runs: { pending: 0, done: 0, unanswered: 0 } };
  for (const receipt of Object.values(receipts)) { status.admissions[receipt.admission]++; if (receipt.admission === 'admitted') status.runs[receipt.run]++; }
  const root = join(options.stateDir, 'job-handoffs');
  for (const directory of ['', ...Object.keys(files)]) {
    const path = directory ? join(root, directory) : root;
    let meta;
    try { meta = await lstat(path); } catch (error) { if (errno(error) === 'ENOENT') continue; throw error; }
    if (!meta.isDirectory() || (meta.mode & 0o777) !== 0o700 || (process.getuid && meta.uid !== process.getuid())) { status.unsafeTree = true; break; }
    if (directory) {
      const names = await readdir(path); files[directory] = names.length;
      if (directory === 'processing') status.heldClaims = names.filter(name => !receipts[name.replace(/\.json$/, '')]).length;
    }
  }
  return status;
}
