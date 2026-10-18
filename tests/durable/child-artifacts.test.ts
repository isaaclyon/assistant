import { mkdtempSync, rmSync, existsSync, statSync, symlinkSync, writeFileSync, readdirSync, mkdirSync, chmodSync, renameSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ChildArtifacts, ChildManifestConflict, ChildOutcomeConflict } from '../../src/durable/child-artifacts.js';
import type { ChildManifest } from '../../src/durable/child-contracts.js';

const B = 'a'.repeat(64), J = 'b'.repeat(64), J2 = 'c'.repeat(64);
const manifest = (over: Partial<ChildManifest> = {}): ChildManifest => ({
  version: 1, batchId: B, jobId: J, launchId: 'launch-1', purpose: 'p', createdAt: 1000, expiresAt: 2000, deadlineAt: 1500,
  endCondition: 'done', task: 't', context: 'c', model: { provider: 'x', modelId: 'y' }, thinkingLevel: 'low', roots: ['/r'],
  workspaceCwd: '/w', provider: { credentialPath: '/c', settingsPath: '/s', account: 'a' }, ...over,
});
const identity = { batchId: B, jobId: J, launchId: 'launch-1' };
let dir: string, art: ChildArtifacts;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'child-art-')); art = new ChildArtifacts(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mode = (p: string) => statSync(p).mode & 0o777;

describe('ChildArtifacts', () => {
  test('prepare is private, idempotent and immutable', async () => {
    await art.prepare(manifest());
    await art.prepare({ ...manifest() });
    expect(await art.readManifest(B, J)).toEqual(manifest());
    expect(mode(art.jobDir(B, J))).toBe(0o700);
    expect(mode(join(art.jobDir(B, J), 'store'))).toBe(0o700);
    expect(mode(join(art.jobDir(B, J), 'manifest.json'))).toBe(0o600);
    await expect(art.prepare(manifest({ task: 'other' }))).rejects.toBeInstanceOf(ChildManifestConflict);
    await expect(art.prepare(manifest({ launchId: 'launch-2' }))).rejects.toBeInstanceOf(ChildManifestConflict);
    expect((await art.readManifest(B, J)).task).toBe('t');
    expect(readdirSync(art.jobDir(B, J)).filter((n) => n.startsWith('.tmp'))).toEqual([]);
  });

  test('rejects non-hex ids and traversal', async () => {
    expect(() => art.batchDir('../x')).toThrow();
    expect(() => art.jobDir(B, 'ABC')).toThrow();
    await expect(art.prepare(manifest({ batchId: 'short' }))).rejects.toThrow();
  });

  test('outcome validates identity, truncates UTF-8 to 64 KiB, first write wins', async () => {
    await art.prepare(manifest());
    expect(await art.readOutcome(B, J)).toBeUndefined();
    await expect(art.writeOutcome({ ...identity, launchId: 'bad', version: 1, status: 'failed', output: '', finishedAt: 1 })).rejects.toThrow();
    const big = 'é'.repeat(70_000);
    await art.writeOutcome({ ...identity, version: 1, status: 'completed', output: big, finishedAt: 5 });
    const out = (await art.readOutcome(B, J))!;
    expect(Buffer.byteLength(out.output)).toBeLessThanOrEqual(64 * 1024);
    expect(out.output).toContain('[Report truncated');
    expect(out.output).not.toContain('\uFFFD');
    await expect(art.writeOutcome({ ...identity, version: 1, status: 'failed', output: 'late', finishedAt: 6 })).rejects.toBeInstanceOf(ChildOutcomeConflict);
    expect((await art.readOutcome(B, J))!.status).toBe('completed');
    const again = { ...identity, version: 1 as const, status: 'completed' as const, output: big, finishedAt: 5 };
    await art.writeOutcome(again);
  });

  test('outcome read enforces output size and manifest launch id', async () => {
    await art.prepare(manifest());
    const file = join(art.jobDir(B, J), 'outcome.json');
    const write = (o: object) => writeFileSync(file, JSON.stringify({ version: 1, batchId: B, jobId: J, status: 'completed', finishedAt: 1, ...o }), { mode: 0o600 });
    write({ launchId: 'launch-1', output: 'x'.repeat(64 * 1024 + 1) });
    await expect(art.readOutcome(B, J)).rejects.toThrow(/too large/);
    rmSync(file);
    write({ launchId: 'other', output: 'ok' });
    await expect(art.readOutcome(B, J)).rejects.toThrow(/launch/);
    rmSync(file);
    write({ launchId: 'launch-1', output: 'ok' });
    expect((await art.readOutcome(B, J))!.output).toBe('ok');
  });

  test('raw files must be private and unshared', async () => {
    await art.prepare(manifest());
    const file = join(art.jobDir(B, J), 'manifest.json');
    chmodSync(file, 0o644);
    await expect(art.readManifest(B, J)).rejects.toThrow(/Unsafe/);
    chmodSync(file, 0o600);
    linkSync(file, join(dir, 'alias'));
    await expect(art.readManifest(B, J)).rejects.toThrow(/Unsafe/);
  });

  test('symlinked or broad ancestors are refused for read, probe and removal without touching targets', async () => {
    await art.prepare(manifest());
    const root = join(dir, 'temporary', 'background-children');
    // symlinked job directory
    const real = join(dir, 'moved');
    renameSync(art.jobDir(B, J), real);
    symlinkSync(real, art.jobDir(B, J));
    await expect(art.readManifest(B, J)).rejects.toThrow(/Unsafe/);
    await expect(art.tryWriterLease(B, J)).rejects.toThrow(/Unsafe/);
    await expect(art.listPreparedBatches()).rejects.toThrow(/Unsafe/);
    rmSync(art.jobDir(B, J));
    renameSync(real, art.jobDir(B, J));
    // broad batch directory
    chmodSync(art.batchDir(B), 0o755);
    await expect(art.readManifest(B, J)).rejects.toThrow(/Unsafe/);
    await expect(art.removeBatch(B)).rejects.toThrow(/Unsafe/);
    expect(existsSync(art.jobDir(B, J))).toBe(true);
    chmodSync(art.batchDir(B), 0o700);
    // symlinked root
    renameSync(root, join(dir, 'real-root'));
    symlinkSync(join(dir, 'real-root'), root);
    await expect(art.tryWriterLease(B, J)).rejects.toThrow(/Unsafe/);
    await expect(art.removeBatch(B)).rejects.toThrow(/Unsafe/);
    expect(existsSync(join(dir, 'real-root', B, J, 'manifest.json'))).toBe(true);
  });

  test('read, probe and removal do not recreate missing directories', async () => {
    await expect(art.readPartial(B, J)).resolves.toBeUndefined();
    await art.removeBatch(B);
    (await art.tryWriterLease(B, J))!();
    expect(existsSync(join(dir, 'temporary', 'background-children'))).toBe(false);
  });

  test('lock files must be regular, unshared and unlinked-symlink free', async () => {
    await art.prepare(manifest());
    const lock = join(art.jobDir(B, J), 'store', 'writer.lock.db');
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), lock);
    await expect(art.tryWriterLease(B, J)).rejects.toThrow(/Unsafe/);
    rmSync(lock);
    writeFileSync(lock, '');
    linkSync(lock, join(dir, 'lock-alias'));
    await expect(art.tryWriterLease(B, J)).rejects.toThrow(/Unsafe/);
    const control = join(dir, 'temporary', 'background-children-control');
    mkdirSync(control, { mode: 0o700 });
    symlinkSync(join(dir, 'target'), join(control, `${B}.db`));
    await expect(art.tryBatchLease(B)).rejects.toThrow(/Unsafe/);
  });

  test('partial and cancel are identity bound', async () => {
    await art.prepare(manifest());
    expect(await art.readPartial(B, J)).toBeUndefined();
    await art.writePartial(identity, 'one');
    await art.writePartial(identity, '日'.repeat(30_000));
    expect(Buffer.byteLength((await art.readPartial(B, J))!)).toBeLessThanOrEqual(64 * 1024);
    await expect(art.writePartial({ ...identity, launchId: 'x' }, 'no')).rejects.toThrow();
    expect(await art.isCancelRequested(identity)).toBe(false);
    await art.requestCancel(identity);
    expect(await art.isCancelRequested(identity)).toBe(true);
    expect(await art.isCancelRequested({ ...identity, launchId: 'other' })).toBe(false);
  });

  test('rejects symlinked and corrupt files', async () => {
    await art.prepare(manifest());
    writeFileSync(join(dir, 'secret'), 'x');
    symlinkSync(join(dir, 'secret'), join(art.jobDir(B, J), 'partial.txt'));
    await expect(art.readPartial(B, J)).rejects.toThrow();
    writeFileSync(join(art.jobDir(B, J), 'outcome.json'), '{bad');
    await expect(art.readOutcome(B, J)).rejects.toThrow();
  });

  test('rejects a symlinked batch directory', async () => {
    mkdirSync(join(dir, 'temporary', 'background-children'), { recursive: true });
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), art.batchDir(B));
    await expect(art.prepare(manifest())).rejects.toThrow();
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });

  test('batch lease competes through real SQLite handles and never recreates removed data', async () => {
    const a = (await art.tryBatchLease(B))!;
    expect(a).toBeTypeOf('function');
    expect(await new ChildArtifacts(dir).tryBatchLease(B)).toBeUndefined();
    expect(await art.tryBatchLease(J)).toBeTypeOf('function');
    a(); a();
    const again = await art.tryBatchLease(B);
    expect(again).toBeTypeOf('function');
    again!();
    expect(mode(join(dir, 'temporary', 'background-children-control', `${B}.db`))).toBe(0o600);
  });

  test('writer lease probes the worker store and does not recreate it', async () => {
    const noStore = await art.tryWriterLease(B, J);
    expect(noStore).toBeTypeOf('function'); noStore!();
    expect(existsSync(art.batchDir(B))).toBe(false);
    await art.prepare(manifest());
    const none = await art.tryWriterLease(B, J);
    none!();
    expect(existsSync(join(art.jobDir(B, J), 'store', 'writer.lock.db'))).toBe(false);
    const lock = join(art.jobDir(B, J), 'store', 'writer.lock.db');
    const worker = new DatabaseSync(lock);
    worker.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    expect(await art.tryWriterLease(B, J)).toBeUndefined();
    worker.close();
    const lease = await art.tryWriterLease(B, J);
    expect(lease).toBeTypeOf('function');
    const competing = new DatabaseSync(lock);
    expect(() => competing.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')).toThrow();
    lease!();
    competing.exec('BEGIN EXCLUSIVE'); competing.close();
  });

  test('removeBatch deletes data, WAL and SHM but keeps the control lock', async () => {
    await art.prepare(manifest());
    await art.prepare(manifest({ jobId: J2 }));
    const lease = (await art.tryBatchLease(B))!;
    const db = new DatabaseSync(join(art.jobDir(B, J), 'store', 'harness.db'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1)');
    expect(existsSync(join(art.jobDir(B, J), 'store', 'harness.db-wal'))).toBe(true);
    db.close();
    await art.removeBatch(B);
    expect(existsSync(art.batchDir(B))).toBe(false);
    expect(existsSync(join(dir, 'temporary', 'background-children-control', `${B}.db`))).toBe(true);
    expect(await new ChildArtifacts(dir).tryBatchLease(B)).toBeUndefined();
    lease();
    await art.removeBatch(B);
  });

  test('listPreparedBatches reports batches, jobs and creation time', async () => {
    expect(await art.listPreparedBatches()).toEqual([]);
    await art.prepare(manifest({ createdAt: 500 }));
    await art.prepare(manifest({ jobId: J2, createdAt: 900 }));
    mkdirSync(join(dir, 'temporary', 'background-children', 'not-an-id'));
    const list = await art.listPreparedBatches();
    expect(list).toEqual([{ batchId: B, createdAt: 500, jobIds: [J, J2] }]);
  });

  test('listPreparedBatches includes job directories without manifests so writers can be probed', async () => {
    await art.prepare(manifest({ createdAt: 500 }));
    mkdirSync(join(art.batchDir(B), J2, 'store'), { recursive: true, mode: 0o700 });
    const lock = join(art.batchDir(B), J2, 'store', 'writer.lock.db');
    const worker = new DatabaseSync(lock);
    worker.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const only = 'd'.repeat(64);
    mkdirSync(join(art.batchDir(only), J, 'store'), { recursive: true, mode: 0o700 });
    chmodSync(art.batchDir(only), 0o700);
    const list = await art.listPreparedBatches();
    expect(list.find((b) => b.batchId === B)).toEqual({ batchId: B, createdAt: 500, jobIds: [J, J2] });
    expect(list.find((b) => b.batchId === only)!.jobIds).toEqual([J]);
    expect(await art.tryWriterLease(B, J2)).toBeUndefined();
    worker.close();
  });
});
