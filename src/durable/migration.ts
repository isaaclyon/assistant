import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readMigrationJson } from '../jobs-migration.js';
import { digestTree } from '../recovery-snapshot.js';
import { fingerprint, normalize as normalizeEnvelope, sourceKey } from './ingress.js';

/**
 * C6 offline migration of disposable, frozen copies. This module never starts a
 * poller, scheduler, transport or Harness, never touches an original, and never
 * infers acceptance from session text. A pending legacy inbox row may already
 * have been dispatched, so it is `uncertain` unless an exact independent
 * receipt proves otherwise. Output is content-free except the private
 * `held-rows.json` and the preserved verbatim copies, both mode 0600/0700.
 */
export const ASSET_KINDS = ['memory', 'receipts', 'history', 'domain-store', 'inbox', 'jobs', 'telegram-profile', 'lock', 'broker-evidence', 'browser-gate'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export type MigrationAssetSpec = { role: string; kind: AssetKind; source: string };
export type MigrationManifest = {
  version: 1;
  assets: MigrationAssetSpec[];
  /** Required when an `inbox` asset exists. `database` is relative to that asset directory. */
  inbox?: { role: string; database: string };
  /** Optional independent receipts: JSON file inside a `receipts` asset directory. */
  receipts?: { role: string; file: string };
};
export type ReceiptOutcome = 'terminal' | 'unaccepted' | 'native-bound';
/** Exact independent proofs. Session JSONL text is deliberately not an authority. */
export const RECEIPT_AUTHORITIES: Record<ReceiptOutcome, readonly string[]> = {
  terminal: ['native-terminal-receipt', 'legacy-terminal-receipt'],
  unaccepted: ['independent-unaccepted-proof'],
  'native-bound': ['native-binding'],
};
export type InboxReceipt = { id: string; payloadSha256: string; outcome: ReceiptOutcome; authority: string; reference: string; fingerprint?: string };
export type RowDisposition = 'native-bound' | 'terminal' | 'unaccepted' | 'uncertain';
export type UncertainReason = 'unparseable' | 'oversize' | 'legacy-shape' | 'no-receipt' | 'receipt-mismatch' | 'receipt-conflict';
export type InboxRowPlan = { idDigest: string; payloadSha256: string; disposition: RowDisposition; reasons: UncertainReason[]; authority?: string; referenceDigest?: string };
export type AssetInventory = { role: string; kind: AssetKind; files: number; bytes: number; digest: string };
export type MigrationPlan = {
  version: 1;
  planDigest: string;
  assets: AssetInventory[];
  inbox?: { rows: number; counts: Record<RowDisposition, number>; orphanReceipts: number; entries: InboxRowPlan[] };
  holds: string[];
};
export type MigrationDisposition = { uncertain: 'quarantine'; unaccepted: 'hold' };
export class MigrationRefusedError extends Error {}
const refuse = (message: string): never => { throw new MigrationRefusedError(message); };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const rowDigest = (id: string) => sha(`row:${id}`);
const hex64 = /^[a-f0-9]{64}$/;
const absolute = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && normalize(path) === path && path !== '/' && !/[\0\r\n]/.test(path);
const local = (path: unknown): path is string => typeof path === 'string' && path !== '' && !isAbsolute(path) && normalize(path) === path && path !== '.' && path !== '..' && !path.startsWith('../') && !/[\0\r\n]/.test(path);
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const uid = () => process.getuid?.() ?? 0;
const MAX_ENTRIES = 250_000;
const MAX_ROWS = 10_000;
const MAX_PAYLOAD = 1024 * 1024;

export function validateManifest(manifest: MigrationManifest): void {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 64) refuse('Invalid migration manifest');
  const roles = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || !/^[a-z][a-z0-9-]{0,63}$/.test(asset.role) || roles.has(asset.role) || !(ASSET_KINDS as readonly string[]).includes(asset.kind) || !absolute(asset.source)) refuse('Invalid migration asset');
    roles.add(asset.role);
  }
  const sources = manifest.assets.map(asset => asset.source);
  if (sources.some((path, index) => sources.slice(index + 1).some(other => overlaps(path, other)))) refuse('Migration assets overlap');
  const byRole = (role: string) => manifest.assets.find(asset => asset.role === role);
  const inboxAssets = manifest.assets.filter(asset => asset.kind === 'inbox');
  if (inboxAssets.length > 1) refuse('At most one inbox asset is supported');
  if (inboxAssets.length === 1) {
    if (!manifest.inbox || manifest.inbox.role !== inboxAssets[0]!.role || !local(manifest.inbox.database)) refuse('Inbox asset requires an exact database selection');
  } else if (manifest.inbox) refuse('Inbox selection names no inbox asset');
  if (manifest.receipts && (byRole(manifest.receipts.role)?.kind !== 'receipts' || !local(manifest.receipts.file))) refuse('Invalid receipts selection');
}

/** Content-free walk with the C6 safety floor: owner, private mode, no links, no hot SQLite sidecars. */
async function inspectAsset(asset: MigrationAssetSpec): Promise<AssetInventory> {
  if (await realpath(asset.source).catch(() => '') !== asset.source) refuse('Noncanonical or missing migration source');
  let files = 0, bytes = 0, entries = 0;
  async function walk(path: string): Promise<void> {
    if (++entries > MAX_ENTRIES) refuse('Migration inventory entry limit exceeded');
    const info = await lstat(path);
    if (info.uid !== uid()) refuse('Migration source ownership mismatch');
    if (info.isSymbolicLink()) refuse('Migration source symlink is not accepted');
    if ((info.mode & 0o077) !== 0) refuse('Migration source mode must be private (0700/0600)');
    if (info.isDirectory()) { for (const entry of await readdir(path)) await walk(join(path, entry)); return; }
    if (!info.isFile()) refuse('Unsafe migration source entry');
    if (info.nlink !== 1) refuse('Migration source hard link is not accepted');
    if (path.endsWith('-journal')) refuse('Hot SQLite journal: possible active writer, freeze a clean copy');
    if (path.endsWith('-wal') && info.size > 0) refuse('Uncheckpointed SQLite WAL: possible active writer, freeze a clean copy');
    files++; bytes += info.size;
  }
  await walk(asset.source);
  let digest: string;
  try { digest = await digestTree(asset.source, false, false, undefined, uid()); } catch (error) { return refuse(`Migration source is unsafe or changed: ${(error as Error).message}`); }
  return { role: asset.role, kind: asset.kind, files, bytes, digest };
}

export async function inventoryMigration(manifest: MigrationManifest): Promise<AssetInventory[]> {
  validateManifest(manifest);
  return Promise.all(manifest.assets.map(inspectAsset));
}

type RawRow = { id: string; payload: string; enqueuedAt: number };
function openImmutable(path: string): DatabaseSync {
  return new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
}
function readInboxRows(path: string): RawRow[] {
  const db = openImmutable(path);
  try {
    const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string }[];
    if (objects.length !== 1 || objects[0]!.type !== 'table' || objects[0]!.name !== 'pending_turn') refuse('Unknown inbox schema');
    const columns = (db.prepare('PRAGMA table_info(pending_turn)').all() as { name: string; type: string; notnull: number; pk: number }[]).map(c => `${c.name}:${c.type}:${c.pk}`).join(',');
    if (columns !== 'id:TEXT:1,payload:TEXT:0,enqueued_at:INTEGER:0') refuse('Unknown inbox schema');
    const count = (db.prepare('SELECT count(*) AS n, coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM pending_turn').get() as { n: number; bytes:number });
    if (count.n > MAX_ROWS) refuse('Inbox row limit exceeded');
    if(count.bytes>64*1024*1024)refuse('Inbox payload byte limit exceeded');
    return (db.prepare('SELECT id,payload,enqueued_at FROM pending_turn ORDER BY rowid').all() as { id: unknown; payload: unknown; enqueued_at: unknown }[])
      .map(row => ({ id: typeof row.id === 'string' ? row.id : refuse('Unknown inbox row identity'), payload: typeof row.payload === 'string' ? row.payload : '\u0000non-text', enqueuedAt: Number(row.enqueued_at) }));
  } finally { db.close(); }
}

async function readReceipts(manifest: MigrationManifest): Promise<InboxReceipt[]> {
  if (!manifest.receipts) return [];
  const asset = manifest.assets.find(entry => entry.role === manifest.receipts!.role)!;
  const { value } = await readMigrationJson(join(asset.source, manifest.receipts.file));
  const v = value as { version?: unknown; receipts?: unknown };
  if (!v || typeof v !== 'object' || v.version !== 1 || !Array.isArray(v.receipts) || v.receipts.length > MAX_ROWS * 4) refuse('Invalid inbox receipts file');
  return (v.receipts as unknown[]).map((raw: unknown): InboxReceipt => {
    const r = raw as Record<string, unknown>;
    const outcome = r?.outcome as ReceiptOutcome;
    if (!r || typeof r.id !== 'string' || !r.id || typeof r.payloadSha256 !== 'string' || !hex64.test(r.payloadSha256) || typeof outcome !== 'string' || !Object.hasOwn(RECEIPT_AUTHORITIES, outcome) ||
        typeof r.authority !== 'string' || !RECEIPT_AUTHORITIES[outcome].includes(r.authority) || typeof r.reference !== 'string' || !/^[A-Za-z0-9:._-]{1,200}$/.test(r.reference) ||
        (outcome === 'native-bound' ? typeof r.fingerprint !== 'string' || !hex64.test(r.fingerprint) : r.fingerprint !== undefined) ||
        Object.keys(r).some(key => !['id', 'payloadSha256', 'outcome', 'authority', 'reference', 'fingerprint'].includes(key))) refuse('Unsupported or malformed receipt (session text is not an authority)');
    return { id: r.id as string, payloadSha256: r.payloadSha256 as string, outcome, authority: r.authority as string, reference: r.reference as string, ...(typeof r.fingerprint === 'string' ? { fingerprint: r.fingerprint } : {}) };
  });
}

/** Native shape: parses as a source envelope and its row id is the exact source key. */
function nativeFingerprint(row: RawRow): string | undefined {
  try { const envelope = normalizeEnvelope(JSON.parse(row.payload)); return sourceKey(envelope) === row.id ? fingerprint(envelope) : undefined; } catch { return undefined; }
}

/** Pure classification. Pending alone is never proof of non-acceptance. */
export function classifyInboxRow(row: RawRow, receipts: InboxReceipt[]): InboxRowPlan {
  const payloadSha256 = sha(row.payload);
  const base = { idDigest: rowDigest(row.id), payloadSha256 };
  if (row.payload.length > MAX_PAYLOAD) return { ...base, disposition: 'uncertain', reasons: ['oversize'] };
  const mine = receipts.filter(receipt => receipt.id === row.id);
  if (!mine.length) return { ...base, disposition: 'uncertain', reasons: [nativeFingerprint(row) === undefined ? (parses(row.payload) ? 'legacy-shape' : 'unparseable') : 'no-receipt'] };
  const receipt = mine[0]!;
  if (new Set(mine.map(r => r.outcome)).size > 1) return { ...base, disposition: 'uncertain', reasons: ['receipt-conflict'] };
  if (mine.some(r => r.payloadSha256 !== payloadSha256 || r.fingerprint !== receipt.fingerprint)) return { ...base, disposition: 'uncertain', reasons: ['receipt-mismatch'] };
  const proof = { authority: receipt.authority, referenceDigest: sha(receipt.reference) };
  if (receipt.outcome === 'native-bound' && nativeFingerprint(row) !== receipt.fingerprint) return { ...base, disposition: 'uncertain', reasons: ['receipt-mismatch'] };
  return { ...base, disposition: receipt.outcome, reasons: [], ...proof };
}
const parses = (payload: string) => { try { JSON.parse(payload); return true; } catch { return false; } };

type Evaluated = { plan: MigrationPlan; rows: RawRow[] };
async function evaluate(manifest: MigrationManifest): Promise<Evaluated> {
  const assets = await inventoryMigration(manifest);
  const holds: string[] = manifest.assets.some(asset => asset.kind === 'browser-gate') ? ['browser-gate-present'] : [];
  let inbox: MigrationPlan['inbox']; let rows: RawRow[] = [];
  if (manifest.inbox) {
    const asset = manifest.assets.find(entry => entry.role === manifest.inbox!.role)!;
    const database = join(asset.source, manifest.inbox.database);
    const info = await lstat(database).catch(() => undefined);
    if (!info?.isFile()) refuse('Inbox database is missing');
    rows = readInboxRows(database);
    const receipts = await readReceipts(manifest);
    const entries = rows.map(row => classifyInboxRow(row, receipts));
    const counts: Record<RowDisposition, number> = { 'native-bound': 0, terminal: 0, unaccepted: 0, uncertain: 0 };
    for (const entry of entries) counts[entry.disposition]++;
    const ids = new Set(rows.map(row => row.id));
    inbox = { rows: rows.length, counts, orphanReceipts: receipts.filter(receipt => !ids.has(receipt.id)).length, entries };
    if (counts.uncertain) holds.push('uncertain-inbox-rows');
    if (counts.unaccepted) holds.push('unaccepted-rows-need-explicit-resubmission');
  }
  // Reading must not have changed any frozen byte (immutable open; no sidecars).
  const after = await inventoryMigration(manifest);
  if (JSON.stringify(after) !== JSON.stringify(assets)) refuse('Migration source changed during inspection');
  const body = { version: 1 as const, assets, inbox, holds, sources: manifest.assets.map(a => [a.role, a.kind, a.source]), selection: [manifest.inbox ?? null, manifest.receipts ?? null] };
  return { plan: { version: 1, planDigest: sha(JSON.stringify(body)), assets, ...(inbox ? { inbox } : {}), holds }, rows };
}

/** Read-only plan. Creates no file, opens SQLite immutable, and refuses a changed frozen copy. */
export async function planMigration(manifest: MigrationManifest): Promise<MigrationPlan> {
  validateManifest(manifest);
  return (await evaluate(manifest)).plan;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Never overwrites: an existing file must be byte-identical. */
async function writeOnce(path: string, bytes: string): Promise<void> {
  const existing = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing !== undefined) { if (!existing.equals(Buffer.from(bytes))) refuse('Existing migration output conflicts with this plan'); return; }
  const temporary = `${path}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') refuse('Existing migration output conflicts with this plan'); throw error; } finally { await unlink(temporary); }
  await fsyncDirectory(dirname(path));
}
async function privateOwnedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o777) !== 0o700) refuse('Migration output requires a private owned directory');
}

export type ApplyOptions = {
  /** Absolute path of a new private directory inside a canonical private parent. */
  outputDir: string;
  expectedPlanDigest: string;
  disposition: MigrationDisposition;
  assertQuiescent?: () => Promise<void>;
  /** Test seam for interruption; production callers omit it. */
  hooks?: { afterAsset?: (role: string) => Promise<void> | void; beforeComplete?: () => Promise<void> | void };
};
export type ApplyResult = { status: 'complete' | 'already-complete'; planDigest: string; activation: 'held' | 'eligible-after-validation'; counts?: Record<RowDisposition, number> };
const COMPLETE = 'migration-complete.json';

/** Stages preserved copies, a native-only inbox and private held rows. Never activates anything. */
export async function applyMigration(manifest: MigrationManifest, options: ApplyOptions): Promise<ApplyResult> {
  validateManifest(manifest);
  if (options.disposition?.uncertain !== 'quarantine' || options.disposition?.unaccepted !== 'hold') refuse('Explicit disposition required: uncertain=quarantine, unaccepted=hold');
  if (!hex64.test(options.expectedPlanDigest)) refuse('Exact inspected plan digest required');
  const output = options.outputDir;
  if (!absolute(output) || manifest.assets.some(asset => overlaps(output, asset.source))) refuse('Invalid migration output path');
  const parent = dirname(output);
  if (await realpath(parent).catch(() => '') !== parent) refuse('Migration output parent must be canonical');
  await privateOwnedDirectory(parent);
  await options.assertQuiescent?.();
  const { plan, rows } = await evaluate(manifest);
  if (plan.planDigest !== options.expectedPlanDigest) refuse('Migration plan changed since inspection');

  const complete = join(output, COMPLETE);
  let created = false;
  try { await mkdir(output, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (await realpath(output) !== output) refuse('Migration output is not canonical');
  await privateOwnedDirectory(output);
  if (!created) {
    const present = await readdir(output);
    if (present.includes(COMPLETE)) { await verifyMigrationOutput(output, plan.planDigest); return summarize('already-complete', plan); }
    if (present.length && !present.includes('apply-started.json')) refuse('Migration destination is occupied by unrelated data');
  }
  await writeOnce(join(output, 'apply-started.json'), JSON.stringify({ version: 1, planDigest: plan.planDigest }));

  const preservedRoot = join(output, 'preserved');
  await mkdir(preservedRoot, { recursive: true, mode: 0o700 });
  for (const asset of manifest.assets) {
    const target = join(preservedRoot, asset.role), expected = plan.assets.find(entry => entry.role === asset.role)!.digest;
    if (await lstat(target).then(() => true, () => false)) {
      if (await digestTree(target, false, false, undefined, uid()).catch(() => '') !== expected) refuse('Existing preserved copy conflicts with the inspected source');
    } else {
      const partial = `${target}.partial`;
      await rm(partial, { recursive: true, force: true }); // Only this tool's own interrupted temporary copy.
      await cp(asset.source, partial, { recursive: true, force: false, errorOnExist: true });
      if (await digestTree(partial, false, true, undefined, uid()) !== expected) refuse('Preserved copy differs from the inspected source');
      await rename(partial, target);
      await fsyncDirectory(preservedRoot);
    }
    await options.hooks?.afterAsset?.(asset.role);
  }

  const reconciliation = { version: 1, planDigest: plan.planDigest, rows: plan.inbox?.entries ?? [] };
  await writeOnce(join(output, 'reconciliation.json'), JSON.stringify(reconciliation));
  let heldDigest: string | null = null, staged = 0;
  if (plan.inbox) {
    const held = rows.flatMap((row, index) => {
      const disposition = plan.inbox!.entries[index]!.disposition;
      return disposition === 'uncertain' || disposition === 'unaccepted' ? [{ id: row.id, payload: row.payload, enqueuedAt: row.enqueuedAt, disposition }] : [];
    });
    const heldBytes = JSON.stringify({ version: 1, planDigest: plan.planDigest, rows: held });
    await writeOnce(join(output, 'held-rows.json'), heldBytes);
    heldDigest = sha(heldBytes);
    const keep = rows.filter((_, index) => plan.inbox!.entries[index]!.disposition === 'native-bound');
    staged = keep.length;
    await stageNativeInbox(join(output, 'staged-inbox.db'), keep);
  }
  const activation = { version: 1, status: plan.holds.length ? 'held' : 'eligible-after-validation', holds: plan.holds, executableActivation: 'refused-until-reconciliation-validated' };
  await writeOnce(join(output, 'activation.json'), JSON.stringify(activation));
  await options.hooks?.beforeComplete?.();
  if ((await evaluate(manifest)).plan.planDigest !== plan.planDigest) refuse('Migration source changed during apply');
  const stagedDigest=plan.inbox?await digestTree(join(output,'staged-inbox.db'),false,false,undefined,uid()):null;
  const reconciliationDigest=sha(await readFile(join(output,'reconciliation.json'))),activationDigest=sha(await readFile(join(output,'activation.json')));
  await writeOnce(complete, JSON.stringify({ version: 1, planDigest: plan.planDigest, assets: plan.assets, heldDigest, stagedRows: staged, stagedDigest, reconciliationDigest, activationDigest, counts: plan.inbox?.counts ?? null, holds: plan.holds }));
  await fsyncDirectory(output);
  return summarize('complete', plan);
}
const summarize = (status: ApplyResult['status'], plan: MigrationPlan): ApplyResult =>
  ({ status, planDigest: plan.planDigest, activation: plan.holds.length ? 'held' : 'eligible-after-validation', ...(plan.inbox ? { counts: plan.inbox.counts } : {}) });

async function stageNativeInbox(path: string, rows: RawRow[]): Promise<void> {
  const same = (a: RawRow[], b: RawRow[]) => JSON.stringify(a) === JSON.stringify(b);
  if (await lstat(path).then(() => true, () => false)) {
    if (!same(readInboxRows(path), rows)) refuse('Existing staged inbox conflicts with this plan');
    return;
  }
  const partial = `${path}.partial`;
  await rm(partial, { force: true });
  const db = new DatabaseSync(partial);
  try {
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE pending_turn (id TEXT PRIMARY KEY, payload TEXT NOT NULL, enqueued_at INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO pending_turn VALUES (?,?,?)');
    for (const row of rows) insert.run(row.id, row.payload, row.enqueuedAt);
  } finally { db.close(); }
  await chmod(partial,0o600);
  const handle = await open(partial, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  await rm(`${partial}-journal`, { force: true });
  if (!same(readInboxRows(partial), rows)) refuse('Staged inbox verification failed');
  await rename(partial, path);
  await fsyncDirectory(dirname(path));
}

/** Validates a completed output against its record. Never trusts file presence alone. */
export async function verifyMigrationOutput(output: string, expectedPlanDigest?: string): Promise<{ planDigest: string; holds: string[]; stagedRows: number }> {
  await privateOwnedDirectory(output);
  const { value } = await readMigrationJson(join(output, COMPLETE));
  const record = value as { planDigest: string; assets: AssetInventory[]; heldDigest: string | null; stagedRows: number; stagedDigest:string|null; reconciliationDigest:string; activationDigest:string; counts: unknown; holds: string[] };
  if (!record || !hex64.test(record.planDigest) || (expectedPlanDigest && record.planDigest !== expectedPlanDigest)) refuse('Completed migration plan changed');
  for (const asset of record.assets) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(asset.role)) refuse('Invalid completed migration record');
    if (await digestTree(join(output, 'preserved', asset.role), false, false, undefined, uid()).catch(() => '') !== asset.digest) refuse('Completed migration destination changed');
  }
  if (record.heldDigest && sha(await readFile(join(output, 'held-rows.json'))) !== record.heldDigest) refuse('Held rows changed');
  if(record.reconciliationDigest!==sha(await readFile(join(output,'reconciliation.json')))||record.activationDigest!==sha(await readFile(join(output,'activation.json'))))refuse('Migration reconciliation or activation record changed');
  if (record.counts !== null && (readInboxRows(join(output, 'staged-inbox.db')).length !== record.stagedRows || record.stagedDigest!==await digestTree(join(output,'staged-inbox.db'),false,false,undefined,uid()))) refuse('Staged inbox changed');
  return { planDigest: record.planDigest, holds: record.holds, stagedRows: record.stagedRows };
}

/** Executable activation guard. C6 produces no reconciliation-validated record, so this
 * always refuses after proving the output is intact; C7 owns any future lift of the hold. */
export async function assertMigrationActivatable(output: string): Promise<never> {
  const verified = await verifyMigrationOutput(output);
  return refuse(`Executable activation refused until reconciliation is validated${verified.holds.length ? ` (holds: ${verified.holds.join(', ')})` : ''}`);
}
