import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boundedChildText, CHILD_REPORT_BYTES, type ChildIdentity, type ChildManifest, type ChildOutcome } from './child-contracts.js';

const ID = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export class ChildArtifactError extends Error {}
export class ChildManifestConflict extends ChildArtifactError {}
export class ChildOutcomeConflict extends ChildArtifactError {}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);
function owned(st: Stats): boolean { const u = uid(); return u === undefined || st.uid === u; }
function fail(message: string): never { throw new ChildArtifactError(message); }
function id(kind: string, value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) fail(`Invalid ${kind}`);
  return value;
}
function identityOf(value: ChildIdentity): ChildIdentity {
  const launchId = (value as { launchId?: unknown }).launchId;
  if (typeof launchId !== 'string' || !launchId || launchId.length > 256) fail('Invalid launchId');
  return { batchId: id('batchId', value.batchId), jobId: id('jobId', value.jobId), launchId };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function validateManifest(v: unknown): ChildManifest {
  const m = v as Record<string, any>;
  const ok = m && typeof m === 'object' && m.version === 1 && isStr(m.launchId) && m.launchId && m.launchId.length <= 256 &&
    ID.test(m.batchId) && ID.test(m.jobId) && isStr(m.purpose) && isNum(m.createdAt) && isNum(m.expiresAt) && isNum(m.deadlineAt) &&
    isStr(m.endCondition) && isStr(m.task) && isStr(m.context) && m.model && isStr(m.model.provider) && isStr(m.model.modelId) &&
    THINKING.has(m.thinkingLevel) && Array.isArray(m.roots) && m.roots.every(isStr) && isStr(m.workspaceCwd) && m.provider &&
    isStr(m.provider.credentialPath) && isStr(m.provider.settingsPath) && isStr(m.provider.account) &&
    (m.provider.credentialFormat === undefined || m.provider.credentialFormat === 'pi-auth' || m.provider.credentialFormat === 'native');
  if (!ok) fail('Invalid child manifest');
  return m as ChildManifest;
}
function validateOutcome(v: unknown): ChildOutcome {
  const o = v as Record<string, any>;
  if (!(o && typeof o === 'object' && o.version === 1 && STATUSES.has(o.status) && isStr(o.output) && isNum(o.finishedAt) &&
    isStr(o.launchId) && ID.test(o.batchId) && ID.test(o.jobId))) fail('Invalid child outcome');
  return o as ChildOutcome;
}

async function fsyncDir(path: string): Promise<void> {
  const h = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await h.sync(); } finally { await h.close(); }
}
const lstatMaybe = (path: string) => lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
/** Verify an existing directory is real, owned and private (temporary: not group/other writable). Missing returns undefined. */
async function checkDir(path: string, loose = false): Promise<Stats | undefined> {
  const st = await lstatMaybe(path);
  if (!st) return undefined;
  if (st.isSymbolicLink() || !st.isDirectory() || !owned(st) || (st.mode & (loose ? 0o022 : 0o077)) !== 0) fail('Unsafe child artifact directory');
  return st;
}
/** Create (or verify) a private directory without following symlinks. */
async function ensureDir(path: string, loose = false): Promise<void> {
  if (!(await lstatMaybe(path))) {
    try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  if (!(await checkDir(path, loose))) fail('Unsafe child artifact directory');
}
/** Verify every existing directory along the chain; false when any is missing. Never creates. */
async function checkChain(paths: { path: string; loose?: boolean }[]): Promise<boolean> {
  for (const { path, loose } of paths) if (!(await checkDir(path, loose))) return false;
  return true;
}
async function checkLockFile(path: string): Promise<Stats | undefined> {
  const st = await lstatMaybe(path);
  if (st && (st.isSymbolicLink() || !st.isFile() || !owned(st) || st.nlink !== 1)) fail('Unsafe lock file');
  return st;
}
/** Read a raw file: no symlink leaf, private owned regular file, bounded. Ancestors must be verified by the caller. */
async function readBounded(path: string, max: number): Promise<string | undefined> {
  let h;
  try { h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') fail('Unsafe child artifact file');
    throw e;
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || !owned(st) || st.nlink !== 1 || (st.mode & 0o077) !== 0) fail('Unsafe child artifact file');
    if (st.size > max) fail('Child artifact too large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const { bytesRead } = await h.read(buf, off, st.size - off, off); if (!bytesRead) break; off += bytesRead; }
    return buf.subarray(0, off).toString('utf8');
  } finally { await h.close(); }
}
async function writeTemp(dir: string, text: string): Promise<string> {
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  const h = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(text, 'utf8'); await h.sync(); } catch (e) { await h.close(); await rm(tmp, { force: true }); throw e; }
  await h.close();
  return tmp;
}
/** Atomically replace a file. */
async function replaceFile(dir: string, name: string, text: string): Promise<void> {
  const tmp = await writeTemp(dir, text);
  try { await rename(tmp, join(dir, name)); } catch (e) { await rm(tmp, { force: true }); throw e; }
  await fsyncDir(dir);
}
/** Atomically create a file; returns false if it already exists. */
async function createFile(dir: string, name: string, text: string): Promise<boolean> {
  const tmp = await writeTemp(dir, text);
  try {
    await link(tmp, join(dir, name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally { await unlink(tmp).catch(() => undefined); }
  await fsyncDir(dir);
  return true;
}
function busy(error: unknown): boolean {
  const e = error as { errcode?: number; message?: string };
  return e.errcode === 5 || e.errcode === 6 || /locked|busy/i.test(e.message ?? '');
}
async function tryLock(path: string): Promise<(() => void) | undefined> {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch (e) { db.close(); if (busy(e)) return undefined; throw e; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (db.isOpen) db.close(); } catch { /* closing releases the OS lock */ }
  };
}

export class ChildArtifacts {
  private readonly root: string;
  private readonly control: string;
  private readonly temporary: string;
  constructor(stateDir: string) {
    this.temporary = join(stateDir, 'temporary');
    this.root = join(stateDir, 'temporary', 'background-children');
    this.control = join(stateDir, 'temporary', 'background-children-control');
  }
  batchDir(batchId: string): string { return join(this.root, id('batchId', batchId)); }
  jobDir(batchId: string, jobId: string): string { return join(this.batchDir(batchId), id('jobId', jobId)); }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.temporary, { recursive: true, mode: 0o700 });
    await ensureDir(this.temporary, true);
  }
  private chain(batchId?: string, jobId?: string, store = false): { path: string; loose?: boolean }[] {
    const c: { path: string; loose?: boolean }[] = [{ path: this.temporary, loose: true }, { path: this.root }];
    if (batchId !== undefined) c.push({ path: this.batchDir(batchId) });
    if (batchId !== undefined && jobId !== undefined) c.push({ path: this.jobDir(batchId, jobId) });
    if (store && batchId !== undefined && jobId !== undefined) c.push({ path: join(this.jobDir(batchId, jobId), 'store') });
    return c;
  }
  /** Read a raw job file after verifying existing ancestry; never creates directories. */
  private async readJobFile(batchId: string, jobId: string, name: string, max: number): Promise<string | undefined> {
    if (!(await checkChain(this.chain(batchId, jobId)))) return undefined;
    return readBounded(join(this.jobDir(batchId, jobId), name), max);
  }

  async prepare(manifest: ChildManifest): Promise<void> {
    const m = validateManifest(manifest);
    await this.ensureRoot();
    await ensureDir(this.root);
    await ensureDir(this.batchDir(m.batchId));
    const job = this.jobDir(m.batchId, m.jobId);
    await ensureDir(job);
    await ensureDir(join(job, 'store'));
    const text = JSON.stringify(m);
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) fail('Child manifest too large');
    if (!(await createFile(job, 'manifest.json', text))) {
      const existing = await this.readManifest(m.batchId, m.jobId);
      if (stable(existing) !== stable(m)) throw new ChildManifestConflict('Child manifest conflicts with prepared identity or configuration');
    }
  }

  async readManifest(batchId: string, jobId: string): Promise<ChildManifest> {
    const text = await this.readJobFile(batchId, jobId, 'manifest.json', MAX_JSON_BYTES);
    if (text === undefined) fail('Child manifest missing');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { fail('Corrupt child manifest'); }
    const m = validateManifest(parsed);
    if (m.batchId !== batchId || m.jobId !== jobId) fail('Child manifest identity mismatch');
    return m;
  }

  private async verified(identity: ChildIdentity): Promise<string> {
    const i = identityOf(identity);
    const m = await this.readManifest(i.batchId, i.jobId);
    if (m.launchId !== i.launchId) fail('Child launch identity mismatch');
    return this.jobDir(i.batchId, i.jobId);
  }

  async readOutcome(batchId: string, jobId: string): Promise<ChildOutcome | undefined> {
    const text = await this.readJobFile(batchId, jobId, 'outcome.json', MAX_JSON_BYTES);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { fail('Corrupt child outcome'); }
    const o = validateOutcome(parsed);
    if (o.batchId !== batchId || o.jobId !== jobId) fail('Child outcome identity mismatch');
    if (Buffer.byteLength(o.output) > CHILD_REPORT_BYTES) fail('Child outcome output too large');
    if ((await this.readManifest(batchId, jobId)).launchId !== o.launchId) fail('Child outcome launch identity mismatch');
    return o;
  }

  /** First outcome wins; an identical repeat is tolerated and a different later value throws ChildOutcomeConflict. Output is truncated to 64 KiB. */
  async writeOutcome(value: ChildOutcome): Promise<void> {
    const job = await this.verified(value);
    const o = validateOutcome(value);
    const out: ChildOutcome = { version: 1, batchId: o.batchId, jobId: o.jobId, launchId: o.launchId, status: o.status, output: boundedChildText(o.output), finishedAt: o.finishedAt };
    if (await createFile(job, 'outcome.json', JSON.stringify(out))) return;
    const existing = await this.readOutcome(o.batchId, o.jobId);
    if (!existing || stable(existing) !== stable(out)) throw new ChildOutcomeConflict('Child outcome already recorded with a different value');
  }

  async writePartial(identity: ChildIdentity, text: string): Promise<void> {
    const job = await this.verified(identity);
    if (typeof text !== 'string') fail('Invalid partial text');
    await replaceFile(job, 'partial.txt', boundedChildText(text));
  }

  async readPartial(batchId: string, jobId: string): Promise<string | undefined> {
    return this.readJobFile(batchId, jobId, 'partial.txt', CHILD_REPORT_BYTES);
  }

  async requestCancel(identity: ChildIdentity): Promise<void> {
    const job = await this.verified(identity);
    await replaceFile(job, 'cancel.json', JSON.stringify({ version: 1, launchId: identity.launchId }));
  }

  async isCancelRequested(identity: ChildIdentity): Promise<boolean> {
    const i = identityOf(identity);
    const text = await this.readJobFile(i.batchId, i.jobId, 'cancel.json', 4096);
    if (text === undefined) return false;
    try { return (JSON.parse(text) as { launchId?: unknown }).launchId === i.launchId; } catch { return false; }
  }

  /** External, persistent lease. The control database is never deleted. */
  async tryBatchLease(batchId: string): Promise<(() => void) | undefined> {
    const b = id('batchId', batchId);
    await this.ensureRoot();
    await ensureDir(this.control);
    const path = join(this.control, `${b}.db`);
    if (!(await lstatMaybe(path))) {
      try { await (await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)).close(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    await checkLockFile(path);
    return tryLock(path);
  }

  /** Holds an exclusive lock on the worker's store/writer.lock.db. A missing store or lock returns a no-op release. */
  async tryWriterLease(batchId: string, jobId: string): Promise<(() => void) | undefined> {
    const noop = () => undefined;
    if (!(await checkChain(this.chain(batchId, jobId, true)))) return noop;
    const path = join(this.jobDir(batchId, jobId), 'store', 'writer.lock.db');
    if (!(await checkLockFile(path))) return noop;
    return tryLock(path);
  }

  async removeBatch(batchId: string): Promise<void> {
    if (!(await checkChain(this.chain(batchId)))) return;
    await rm(this.batchDir(batchId), { recursive: true, force: true });
    await fsyncDir(this.root).catch(() => undefined);
  }

  async listPreparedBatches(): Promise<{ batchId: string; createdAt: number; jobIds: string[] }[]> {
    if (!(await checkChain(this.chain()))) return [];
    const result: { batchId: string; createdAt: number; jobIds: string[] }[] = [];
    for (const batchId of await readdir(this.root)) {
      if (!ID.test(batchId)) continue;
      const dir = join(this.root, batchId);
      const st = await checkDir(dir);
      if (!st) continue;
      const jobIds: string[] = [];
      let createdAt = Math.floor(st.mtimeMs);
      let fromManifest: number | undefined;
      for (const jobId of (await readdir(dir)).sort()) {
        if (!ID.test(jobId) || !(await checkDir(join(dir, jobId)))) continue;
        jobIds.push(jobId);
        if (!(await lstatMaybe(join(dir, jobId, 'manifest.json')))) continue;
        const m = await this.readManifest(batchId, jobId);
        fromManifest = Math.min(fromManifest ?? Infinity, m.createdAt);
      }
      if (fromManifest !== undefined) createdAt = fromManifest;
      result.push({ batchId, createdAt, jobIds });
    }
    return result.sort((a, b) => a.batchId.localeCompare(b.batchId));
  }
}
