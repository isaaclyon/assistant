import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { digestTree } from '../../src/recovery-snapshot.js';
import { fingerprint, normalize, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { applyMigration, assertMigrationActivatable, planMigration, verifyMigrationOutput, MigrationRefusedError, type MigrationManifest, type InboxReceipt } from '../../src/durable/migration.js';
import { runMigrationCli } from '../../src/durable/migration-cli.js';

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const envelope = (id: number): SourceEnvelope => ({ instance: 'test', principal: 'person', bot: 'bot', chatId: 10, threadId: 2, messageIds: [id], originalAt: 1_700_000_000_000 + id, content: `SECRET-CONTENT ${id}` });
const native = (id: number) => { const e = normalize(envelope(id)); return { id: sourceKey(e), payload: JSON.stringify(e), fp: fingerprint(e) }; };
const legacy = (id: number) => ({ id: `10:${id}`, payload: JSON.stringify({ routing: { chatId: 10 }, text: `SECRET-LEGACY ${id}`, files: [] }) });

async function priv(path: string, mode = 0o700) { await mkdir(path, { recursive: true, mode }); await chmod(path, mode); return path; }
async function put(path: string, content: string) { await writeFile(path, content, { mode: 0o600 }); await chmod(path, 0o600); }

async function fixture(options: { receipts?: (rows: Record<string, { id: string; payload: string; fp?: string }>) => InboxReceipt[] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'durable-migration-')));
  cleanup.push(root); await chmod(root, 0o700);
  const dirs = Object.fromEntries(await Promise.all(['memory', 'history', 'inbox', 'receipts', 'places', 'telegram', 'broker', 'gate', 'jobs'].map(async n => [n, await priv(join(root, 'frozen', n))])));
  await put(join(dirs.memory!, 'note.md'), '# synthetic note\n');
  await put(join(dirs.jobs!, 'jobs.json'), '{"jobs":[]}\n');
  await put(join(dirs.telegram!, 'profile.json'), '{"token":"SECRET-TOKEN"}\n');
  await put(join(dirs.gate!, 'crash-gate'), 'gate\n');
  for (const [name, dir] of [['harness.db', dirs.history!], ['ledger.db', dirs.places!], ['broker.db', dirs.broker!]] as const) {
    const db = new DatabaseSync(join(dir, name)); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (42)'); db.close();
    await chmod(join(dir, name), 0o600);
  }
  const rows = { nativeBound: native(1), nativeNoReceipt: native(2), legacyPending: legacy(3), garbage: { id: '10:4', payload: 'not json SECRET-RAW' }, terminal: legacy(5), unaccepted: legacy(6), mismatch: legacy(7) };
  const db = new DatabaseSync(join(dirs.inbox!, 'inbox.db'));
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE pending_turn (id TEXT PRIMARY KEY, payload TEXT NOT NULL, enqueued_at INTEGER NOT NULL)');
  let n = 0; for (const row of Object.values(rows)) db.prepare('INSERT INTO pending_turn VALUES (?,?,?)').run(row.id, row.payload, ++n);
  db.close(); await chmod(join(dirs.inbox!, 'inbox.db'), 0o600);
  const receipts: InboxReceipt[] = options.receipts?.(rows as never) ?? [
    { id: rows.nativeBound.id, payloadSha256: sha(rows.nativeBound.payload), outcome: 'native-bound', authority: 'native-binding', reference: 'binding:1', fingerprint: rows.nativeBound.fp },
    { id: rows.terminal.id, payloadSha256: sha(rows.terminal.payload), outcome: 'terminal', authority: 'legacy-terminal-receipt', reference: 'occurrence:5' },
    { id: rows.unaccepted.id, payloadSha256: sha(rows.unaccepted.payload), outcome: 'unaccepted', authority: 'independent-unaccepted-proof', reference: 'proof:6' },
    { id: rows.mismatch.id, payloadSha256: sha('different bytes'), outcome: 'terminal', authority: 'legacy-terminal-receipt', reference: 'occurrence:7' },
  ];
  await put(join(dirs.receipts!, 'inbox-receipts.json'), JSON.stringify({ version: 1, receipts }));
  const manifest: MigrationManifest = { version: 1,
    assets: [['memory', 'memory'], ['history', 'history'], ['inbox', 'inbox'], ['receipts', 'receipts'], ['places', 'domain-store'], ['telegram', 'telegram-profile'], ['broker', 'broker-evidence'], ['gate', 'browser-gate'], ['jobs', 'jobs']]
      .map(([role, kind]) => ({ role: role!, kind: kind as never, source: dirs[role!]! })),
    inbox: { role: 'inbox', database: 'inbox.db' }, receipts: { role: 'receipts', file: 'inbox-receipts.json' } };
  const parent = await priv(join(root, 'out'));
  return { root, dirs, manifest, rows, parent, output: join(parent, 'c6') };
}
const treeDigests = async (manifest: MigrationManifest) => Promise.all(manifest.assets.map(a => digestTree(a.source, false)));
const disposition = { uncertain: 'quarantine', unaccepted: 'hold' } as const;

it('classifies only receipt-proven rows and keeps every other pending row uncertain, content-free and read-only', async () => {
  const f = await fixture();
  const before = await treeDigests(f.manifest), names = await readdir(f.dirs.inbox!);
  const plan = await planMigration(f.manifest);
  expect(await treeDigests(f.manifest)).toEqual(before);
  expect(await readdir(f.dirs.inbox!)).toEqual(names);
  const byDigest = new Map(plan.inbox!.entries.map(e => [e.idDigest, e]));
  const entry = (id: string) => byDigest.get(sha(`row:${id}`))!;
  expect(entry(f.rows.nativeBound.id).disposition).toBe('native-bound');
  expect(entry(f.rows.nativeNoReceipt.id)).toMatchObject({ disposition: 'uncertain', reasons: ['no-receipt'] });
  expect(entry(f.rows.legacyPending.id)).toMatchObject({ disposition: 'uncertain', reasons: ['legacy-shape'] });
  expect(entry(f.rows.garbage.id)).toMatchObject({ disposition: 'uncertain', reasons: ['unparseable'] });
  expect(entry(f.rows.terminal.id)).toMatchObject({ disposition: 'terminal', authority: 'legacy-terminal-receipt' });
  expect(entry(f.rows.unaccepted.id)).toMatchObject({ disposition: 'unaccepted' });
  expect(entry(f.rows.mismatch.id)).toMatchObject({ disposition: 'uncertain', reasons: ['receipt-mismatch'] });
  expect(plan.inbox!.counts).toEqual({ 'native-bound': 1, terminal: 1, unaccepted: 1, uncertain: 4 });
  expect(plan.holds).toEqual(['browser-gate-present', 'uncertain-inbox-rows', 'unaccepted-rows-need-explicit-resubmission']);
  expect(plan.assets.map(a => a.kind)).toContain('broker-evidence');
  expect(JSON.stringify(plan)).not.toMatch(/SECRET|10:3|token/);
  expect(await planMigration(f.manifest)).toEqual(plan);
});

it('refuses session text, unknown authorities and conflicting receipts instead of classifying', async () => {
  const bad = await fixture({ receipts: rows => [{ id: rows.legacyPending!.id, payloadSha256: sha(rows.legacyPending!.payload), outcome: 'terminal', authority: 'session-jsonl-text', reference: 'x' }] });
  await expect(planMigration(bad.manifest)).rejects.toThrow('session text is not an authority');
  const conflict = await fixture({ receipts: rows => [
    { id: rows.legacyPending!.id, payloadSha256: sha(rows.legacyPending!.payload), outcome: 'terminal', authority: 'legacy-terminal-receipt', reference: 'a' },
    { id: rows.legacyPending!.id, payloadSha256: sha(rows.legacyPending!.payload), outcome: 'unaccepted', authority: 'independent-unaccepted-proof', reference: 'b' }] });
  const plan = await planMigration(conflict.manifest);
  expect(plan.inbox!.entries.find(e => e.idDigest === sha(`row:${conflict.rows.legacyPending.id}`))).toMatchObject({ disposition: 'uncertain', reasons: ['receipt-conflict'] });
  const forged = await fixture({ receipts: rows => [{ id: rows.nativeBound!.id, payloadSha256: sha(rows.nativeBound!.payload), outcome: 'native-bound', authority: 'native-binding', reference: 'b', fingerprint: 'a'.repeat(64) }] });
  expect((await planMigration(forged.manifest)).inbox!.counts['native-bound']).toBe(0);
});

it('applies a verbatim preserved copy, native-only staged inbox and private held rows without touching originals', async () => {
  const f = await fixture();
  const before = await treeDigests(f.manifest);
  const plan = await planMigration(f.manifest);
  const result = await applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition });
  expect(result).toMatchObject({ status: 'complete', activation: 'held', counts: { 'native-bound': 1, uncertain: 4 } });
  expect(await treeDigests(f.manifest)).toEqual(before);
  for (const asset of f.manifest.assets) expect(await digestTree(join(f.output, 'preserved', asset.role), false)).toBe(plan.assets.find(a => a.role === asset.role)!.digest);
  // Exact byte and anchor preservation, including the legacy inbox with every row.
  expect(await readFile(join(f.output, 'preserved', 'inbox', 'inbox.db'))).toEqual(await readFile(join(f.dirs.inbox!, 'inbox.db')));
  expect((await lstat(join(f.output,'staged-inbox.db'))).mode & 0o777).toBe(0o600);
  const staged = new DatabaseSync(join(f.output, 'staged-inbox.db'), { readOnly: true });
  expect(staged.prepare('SELECT id,payload FROM pending_turn').all()).toEqual([{ id: f.rows.nativeBound.id, payload: f.rows.nativeBound.payload }]);
  staged.close();
  const held = JSON.parse(await readFile(join(f.output, 'held-rows.json'), 'utf8')).rows as { id: string; payload: string }[];
  expect(held.map(r => r.id).sort()).toEqual([f.rows.nativeNoReceipt.id, f.rows.legacyPending.id, f.rows.garbage.id, f.rows.unaccepted.id, f.rows.mismatch.id].sort());
  expect(held.find(r => r.id === '10:4')!.payload).toBe('not json SECRET-RAW');
  expect((await readdir(f.output)).sort()).toEqual(['activation.json', 'apply-started.json', 'held-rows.json', 'migration-complete.json', 'preserved', 'reconciliation.json', 'staged-inbox.db']);
  expect(await readFile(join(f.output, 'reconciliation.json'), 'utf8')).not.toMatch(/SECRET/);
  expect(await verifyMigrationOutput(f.output)).toMatchObject({ planDigest: plan.planDigest, stagedRows: 1 });
  await expect(assertMigrationActivatable(f.output)).rejects.toThrow('Executable activation refused');
  // Idempotent retry leaves existing output byte-identical.
  const complete = await readFile(join(f.output, 'migration-complete.json'));
  expect(await applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition })).toMatchObject({ status: 'already-complete' });
  expect(await readFile(join(f.output, 'migration-complete.json'))).toEqual(complete);
});

it('detects same-count staged inbox changes and changed reconciliation records',async()=>{
 for(const target of ['staged-inbox.db','reconciliation.json','activation.json']){
  const f=await fixture(),plan=await planMigration(f.manifest);await applyMigration(f.manifest,{outputDir:f.output,expectedPlanDigest:plan.planDigest,disposition});
  if(target==='staged-inbox.db'){const db=new DatabaseSync(join(f.output,target));try{db.prepare('UPDATE pending_turn SET payload=?').run('CHANGED');}finally{db.close();}}
  else await put(join(f.output,target),'{}');
  await expect(verifyMigrationOutput(f.output)).rejects.toThrow(/changed/i);
 }
});

it('requires explicit disposition, the exact inspected digest and refuses changed bytes', async () => {
  const f = await fixture();
  const plan = await planMigration(f.manifest);
  await expect(applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition: {} as never })).rejects.toThrow('Explicit disposition');
  await expect(applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: 'f'.repeat(64), disposition })).rejects.toThrow('plan changed');
  await put(join(f.dirs.memory!, 'note.md'), '# edited after inspection\n');
  await expect(applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition })).rejects.toThrow('plan changed');
  await expect(readdir(f.output)).rejects.toThrow(); // nothing was created
  const again = await planMigration(f.manifest);
  await expect(applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: again.planDigest, disposition, hooks: { beforeComplete: async () => { await put(join(f.dirs.memory!, 'note.md'), '# edited during apply\n'); } } })).rejects.toThrow('changed during apply');
  await expect(readFile(join(f.output, 'migration-complete.json'))).rejects.toThrow();
});

it('refuses unsafe sources: symlink, hard link, open modes, hot journal and WAL, schema drift', async () => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, string]> = [
    ['symlink', f => symlink('/etc/hosts', join(f.dirs.memory!, 'escape')), 'symlink'],
    ['hardlink', async f => { await link(join(f.dirs.memory!, 'note.md'), join(f.dirs.jobs!, 'alias')); }, 'hard link'],
    ['mode', async f => { await chmod(join(f.dirs.memory!, 'note.md'), 0o644); }, 'private'],
    ['journal', f => put(join(f.dirs.history!, 'harness.db-journal'), 'x'), 'journal'],
    ['wal', f => put(join(f.dirs.history!, 'harness.db-wal'), 'frames'), 'WAL'],
    ['schema', async f => { const db = new DatabaseSync(join(f.dirs.inbox!, 'inbox.db')); db.exec('CREATE TABLE extra(x)'); db.close(); }, 'Unknown inbox schema'],
  ];
  for (const [, mutate, message] of cases) { const f = await fixture(); await mutate(f); await expect(planMigration(f.manifest)).rejects.toThrow(message); }
  const f = await fixture();
  await expect(planMigration({ ...f.manifest, assets: [...f.manifest.assets, { role: 'nested', kind: 'memory', source: join(f.dirs.memory!, 'inside') }] })).rejects.toThrow('overlap');
  await expect(planMigration({ ...f.manifest, assets: f.manifest.assets.map(a => a.role === 'memory' ? { ...a, source: `${a.source}/../memory` } : a) })).rejects.toThrow('Invalid migration asset');
});

it('refuses aggregate inbox payloads above the bound without creating output',async()=>{
 const f=await fixture();
 const db=new DatabaseSync(join(f.dirs.inbox!,'inbox.db'));
 try{db.exec("DELETE FROM pending_turn; WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<65) INSERT INTO pending_turn SELECT 'large-'||i, CAST(zeroblob(1048576) AS TEXT), i FROM n");}finally{db.close();}
 await expect(planMigration(f.manifest)).rejects.toThrow('Inbox payload byte limit exceeded');
 await expect(readdir(f.output)).rejects.toThrow();
 const retained=new DatabaseSync(join(f.dirs.inbox!,'inbox.db'),{readOnly:true});
 try{expect(retained.prepare('SELECT count(*) AS n FROM pending_turn').get()).toEqual({n:65});}finally{retained.close();}
});

it('refuses conflicting destinations and never overwrites preserved copies', async () => {
  const f = await fixture();
  const plan = await planMigration(f.manifest);
  await priv(f.output); await put(join(f.output, 'unrelated.txt'), 'mine');
  await expect(applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition })).rejects.toThrow('occupied by unrelated');
  expect(await readFile(join(f.output, 'unrelated.txt'), 'utf8')).toBe('mine');
  await expect(applyMigration(f.manifest, { outputDir: join(f.dirs.memory!, 'out'), expectedPlanDigest: plan.planDigest, disposition })).rejects.toThrow('output path');
  await chmod(f.parent, 0o755);
  await expect(applyMigration(f.manifest, { outputDir: join(f.parent, 'other'), expectedPlanDigest: plan.planDigest, disposition })).rejects.toThrow('private owned');
});

it('recovers an interrupted apply by verifying, not overwriting, and refuses tampered partial output', async () => {
  const f = await fixture();
  const plan = await planMigration(f.manifest);
  let seen = 0;
  await expect(applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition, hooks: { afterAsset: () => { if (++seen === 3) throw new Error('simulated crash'); } } })).rejects.toThrow('simulated crash');
  await expect(readFile(join(f.output, 'migration-complete.json'))).rejects.toThrow();
  // A crash can also leave an unfinished temporary copy of this tool.
  await mkdir(join(f.output, 'preserved', 'places.partial'), { recursive: true, mode: 0o700 });
  expect(await applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition })).toMatchObject({ status: 'complete' });
  await verifyMigrationOutput(f.output);
  // Tampering with retained evidence is detected by retry and by verification.
  await chmod(join(f.output, 'preserved', 'memory', 'note.md'), 0o600);
  await put(join(f.output, 'preserved', 'memory', 'note.md'), 'tampered');
  await expect(applyMigration(f.manifest, { outputDir: f.output, expectedPlanDigest: plan.planDigest, disposition })).rejects.toThrow('destination changed');
  await expect(verifyMigrationOutput(f.output)).rejects.toThrow(MigrationRefusedError);

  const g = await fixture(); const planG = await planMigration(g.manifest);
  await expect(applyMigration(g.manifest, { outputDir: g.output, expectedPlanDigest: planG.planDigest, disposition, hooks: { afterAsset: () => { throw new Error('crash'); } } })).rejects.toThrow('crash');
  await put(join(g.output, 'preserved', 'memory', 'note.md'), 'tampered');
  await expect(applyMigration(g.manifest, { outputDir: g.output, expectedPlanDigest: planG.planDigest, disposition })).rejects.toThrow('conflicts');
  await put(join(g.output, 'apply-started.json'), JSON.stringify({ version: 1, planDigest: 'a'.repeat(64) }));
  await expect(applyMigration(g.manifest, { outputDir: g.output, expectedPlanDigest: planG.planDigest, disposition })).rejects.toThrow('conflicts');
});

it('exposes inventory, dry-run, apply and verify through a content-free CLI', async () => {
  const f = await fixture();
  const manifestPath = join(f.root, 'manifest.json'); await put(manifestPath, JSON.stringify(f.manifest));
  const lines: string[] = [];
  const run = (...args: string[]) => runMigrationCli(args, line => lines.push(line));
  expect(await run('inventory', '--manifest', manifestPath)).toBe(0);
  expect(await run('dry-run', '--manifest', manifestPath)).toBe(0);
  const digest = JSON.parse(lines.at(-1)!).planDigest as string;
  expect(await run('apply', '--manifest', manifestPath, '--output', f.output, '--plan-digest', digest)).toBe(1);
  expect(await run('apply', '--manifest', manifestPath, '--output', f.output, '--plan-digest', digest, '--uncertain', 'quarantine', '--unaccepted', 'hold')).toBe(0);
  expect(await run('verify', '--output', f.output)).toBe(0);
  expect(lines.join('\n')).not.toMatch(/SECRET|10:3/);
});
