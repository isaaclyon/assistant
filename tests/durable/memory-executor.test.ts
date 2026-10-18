import { afterEach, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarkdownMemoryExecutor, prepareMemoryIntent, type MemoryView, type PrepareMemoryIntentInput } from '../../src/durable/memory-executor.js';
import type { MemoryOperation } from '../../src/durable/operations.js';
import { executeMemoryOperation } from '../../.pi/skills/personal-memory/scripts/memory.mjs';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const isaac: MemoryView = { principal: 'isaac', memoryView: 'owner-and-household' };
const emma: MemoryView = { principal: 'emma', memoryView: 'owner-and-household' };
const control = { signal: new AbortController().signal, assertAuthority: async () => {} };
let counter = 0;

async function vault(git = false) {
  const base = await mkdtemp(join(tmpdir(), 'memory-executor-')); dirs.push(base);
  const root = join(base, 'vault'); await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  if (git) {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 't@example.invalid'); run('config', 'commit.gpgsign', 'false');
    await writeFile(join(root, 'README.md'), 'vault\n'); run('add', 'README.md'); run('commit', '-q', '-m', 'init');
  }
  return root;
}
function operation(intent: MemoryOperation['intent'], principal = 'isaac', overrides: Partial<MemoryOperation> = {}): MemoryOperation {
  const id = `op-${++counter}`;
  return { version: 1, id, fingerprint: `fp-${id}`, handler: { name: 'assistant.memory.markdown', version: 1 },
    binding: { principal, target: { chatId: 'chat', threadId: null }, epoch: 'epoch' }, intent, expiresAt: Date.now() + 60_000, status: 'executing',
    approval: { token: 't', presentation: { messageId: 'm', at: 1 }, decision: { principal, at: 1, choice: 'approve' }, invalidated: null },
    taskId: null, result: null, reason: null, ...overrides };
}
async function create(root: string, request = { type: 'reference', title: 'Seed', tags: [], body: 'one\n' }) {
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'create', request });
  const op = operation(intent);
  await createMarkdownMemoryExecutor({ root }).execute(op, control);
  return intent.noteId;
}
const noteRaw = async (root: string, id: string) => readFile(join(root, 'references', `${id}.md`), 'utf8');
const gitLog = (root: string) => execFileSync('git', ['log', '--format=%s%n%b'], { cwd: root, encoding: 'utf8' });
const commitCount = (root: string) => Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }));

function crash(root: string, op: MemoryOperation, point: string, git = false) {
  const file = join(root, '..', `${op.id}.json`);
  return writeFile(file, JSON.stringify(op)).then(() => {
    const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/operations-loader.mjs', import.meta.url)), fileURLToPath(new URL('./fixtures/memory-executor-worker.ts', import.meta.url)), root, file, point, git ? 'git' : 'plain'], { encoding: 'utf8' });
    expect(child.signal, child.stderr).toBe('SIGKILL');
  });
}

test('create, update, append, share and delete use deterministic intents and exact receipts', async () => {
  const root = await vault(); const executor = createMarkdownMemoryExecutor({ root });
  const { intent: made } = await prepareMemoryIntent({ root, view: isaac }, { action: 'create', request: { type: 'reference', title: 'T', tags: ['a'], body: 'one\n' } });
  const first = await executor.execute(operation(made), control);
  expect(first).toMatchObject({ revision: made.postRevision, git: 'not-requested' });
  expect(first.receipt).toMatch(/^memory-operation:[0-9a-f]{64}:sha256:/);
  const { noteId } = made;
  const inputs: PrepareMemoryIntentInput[] = [
    { action: 'update' as const, noteId, patch: { title: 'T2' } },
    { action: 'append' as const, noteId, append: 'two\n' },
    { action: 'share' as const, noteId, patch: { scope: 'household' } },
  ];
  for (const input of inputs) {
    const { intent } = await prepareMemoryIntent({ root, view: isaac }, input);
    expect((await executor.execute(operation(intent), control)).revision).toBe(intent.postRevision);
  }
  const raw = await noteRaw(root, noteId);
  expect(raw).toContain('title: "T2"'); expect(raw).toContain('scope: "household"'); expect(raw.match(/two/g)).toHaveLength(1);
  const { intent: removal } = await prepareMemoryIntent({ root, view: isaac }, { action: 'delete', noteId });
  expect(removal.postRevision).toBeNull();
  expect((await executor.execute(operation(removal), control)).revision).toBeNull();
  await expect(noteRaw(root, noteId)).rejects.toThrow();
});

test('legacy and native writers share one vault lock and reject the stale legacy revision',async()=>{
 const root=await vault(),id=await create(root);
 const {intent}=await prepareMemoryIntent({root,view:isaac},{action:'append',noteId:id,append:'native-tail\n'});
 let entered!:()=>void,release!:()=>void;
 const held=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const native=createMarkdownMemoryExecutor({root,hooks:{afterReceipt:async()=>{entered();await gate;}}}).execute(operation(intent),control);
 await held;
 let settled=false;
 const legacy=executeMemoryOperation('update',{id,ifRevision:intent.preRevision,patch:{title:'Legacy change'}},{env:{PI_TELEGRAM_PRINCIPAL:'isaac',PI_TELEGRAM_MEMORY_VIEW:'owner-and-household',PI_TELEGRAM_MEMORY_DIR:root,PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT:'0'},cwd:process.cwd()}).then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
 // Catch immediately so an assertion cannot produce an unhandled rejection.
 const outcome=legacy.then(value=>({value,error:null}),error=>({value:null,error}));
 let blocked=false;
 try{await new Promise(resolve=>setTimeout(resolve,50));blocked=!settled;}finally{release();}
 await native;expect(blocked).toBe(true);
 expect((await outcome).error).toMatchObject({code:'REVISION_CONFLICT'});
 expect(await noteRaw(root,id)).toContain('native-tail');expect(await noteRaw(root,id)).not.toContain('Legacy change');
});

test('a legacy mutation invalidates a prepared native intent before a native receipt or effect',async()=>{
 const root=await vault(),id=await create(root);
 const {intent}=await prepareMemoryIntent({root,view:isaac},{action:'append',noteId:id,append:'native-tail\n'});
 await executeMemoryOperation('update',{id,ifRevision:intent.preRevision,patch:{title:'Legacy change'}},{env:{PI_TELEGRAM_PRINCIPAL:'isaac',PI_TELEGRAM_MEMORY_VIEW:'owner-and-household',PI_TELEGRAM_MEMORY_DIR:root,PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT:'0'},cwd:process.cwd()});
 const before=await noteRaw(root,id),count=(await readdir(join(root,'.operations'))).length;
 await expect(createMarkdownMemoryExecutor({root}).execute(operation(intent),control)).rejects.toMatchObject({definitelyNotApplied:true});
 expect(await noteRaw(root,id)).toBe(before);expect(before).toContain('Legacy change');expect(before).not.toContain('native-tail');expect(await readdir(join(root,'.operations'))).toHaveLength(count);
});

test('SIGKILL after Markdown rename and before the native result is recognized without repeating append', async () => {
  const root = await vault(); const id = await create(root);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'append', noteId: id, append: 'tail\n' });
  const op = operation(intent);
  await crash(root, op, 'markdown');
  const after = await noteRaw(root, id); expect(after.match(/tail/g)).toHaveLength(1);
  const executor = createMarkdownMemoryExecutor({ root });
  expect(await executor.reconcile(op, control)).toMatchObject({ status: 'succeeded', result: { revision: intent.postRevision, git: 'not-requested' } });
  // A retried execute recognizes the receipt instead of planning a second append.
  expect((await executor.execute(op, control)).revision).toBe(intent.postRevision);
  expect(await noteRaw(root, id)).toBe(after);
});

test('SIGKILL after create keeps the intended note id and never creates another note', async () => {
  const root = await vault();
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'create', request: { type: 'reference', title: 'C', tags: [], body: '' } });
  const op = operation(intent); await crash(root, op, 'markdown');
  const executor = createMarkdownMemoryExecutor({ root });
  expect(await executor.reconcile(op, control)).toMatchObject({ status: 'succeeded' });
  await executor.execute(op, control);
  expect(await readdir(join(root, 'references'))).toEqual([`${intent.noteId}.md`]);
});

test('SIGKILL after receipt and before Markdown shows no effect and does not authorize a repeat', async () => {
  const root = await vault(); const id = await create(root);
  const before = await noteRaw(root, id);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'append', noteId: id, append: 'x\n' });
  const op = operation(intent); await crash(root, op, 'receipt');
  expect(await noteRaw(root, id)).toBe(before);
  expect(await createMarkdownMemoryExecutor({ root }).reconcile(op, control)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('pre-effect') });
});

test('a missing receipt stays uncertain even when the Markdown equals the intended result', async () => {
  const root = await vault(); const id = await create(root);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'update', noteId: id, patch: { title: 'New' } });
  const op = operation(intent); const executor = createMarkdownMemoryExecutor({ root });
  await executor.execute(op, control);
  await rm(join(root, '.operations'), { recursive: true });
  expect(await executor.reconcile(op, control)).toMatchObject({ status: 'unknown' });
  expect(await executor.reconcile({ ...op, id: 'other-op' }, control)).toMatchObject({ status: 'unknown' });
});

test('changed or deleted notes after a crash stop reconciliation', async () => {
  const root = await vault(); const id = await create(root);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'append', noteId: id, append: 'z\n' });
  const op = operation(intent); await crash(root, op, 'markdown');
  const executor = createMarkdownMemoryExecutor({ root });
  await writeFile(join(root, 'references', `${id}.md`), `${await noteRaw(root, id)}edited\n`);
  expect(await executor.reconcile(op, control)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('does not match') });
  await expect(executor.execute(op, control)).rejects.toThrow();
  await rm(join(root, 'references', `${id}.md`));
  expect(await executor.reconcile(op, control)).toMatchObject({ status: 'unknown' });
});

test('revision, scope, authority and approval failures happen before any receipt or effect', async () => {
  const root = await vault(); const id = await create(root);
  const executor = createMarkdownMemoryExecutor({ root });
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'update', noteId: id, patch: { title: 'A' } });
  const stale = operation(intent);
  await executor.execute(operation((await prepareMemoryIntent({ root, view: isaac }, { action: 'update', noteId: id, patch: { title: 'B' } })).intent), control);
  const current = await noteRaw(root, id);
  await expect(executor.execute(stale, control)).rejects.toMatchObject({ definitelyNotApplied: true });
  const fresh = (await prepareMemoryIntent({ root, view: isaac }, { action: 'update', noteId: id, patch: { title: 'C' } })).intent;
  await expect(executor.execute(operation(fresh, 'emma'), control)).rejects.toMatchObject({ definitelyNotApplied: true });
  await expect(prepareMemoryIntent({ root, view: emma }, { action: 'update', noteId: id, patch: { title: 'C' } })).rejects.toThrow();
  await expect(executor.execute(operation(fresh), { ...control, assertAuthority: async () => { throw new Error('revoked'); } })).rejects.toMatchObject({ definitelyNotApplied: true });
  await expect(executor.execute(operation({ ...fresh, postRevision: 'sha256:wrong' }), control)).rejects.toThrow(/intended revisions/);
  await expect(executor.execute(operation(fresh, 'isaac', { approval: { token: 't', presentation: null, decision: null, invalidated: null } }), control)).rejects.toThrow(/approved/);
  const removal = (await prepareMemoryIntent({ root, view: isaac }, { action: 'delete', noteId: id })).intent;
  await expect(executor.execute(operation(removal, 'isaac', { approval: { token: 't', presentation: null, decision: { principal: 'isaac', at: 1, choice: 'approve' }, invalidated: null } }), control)).rejects.toThrow(/approved/);
  await expect(executor.execute(operation({ ...fresh, action: 'update', payload: { patch: { scope: 'household' } } }), control)).rejects.toThrow(/share/i);
  expect(await noteRaw(root, id)).toBe(current);
  expect(await readdir(join(root, '.operations'))).toHaveLength(2);
});

test('Git commit is separate: success, kill before Git, and kill after Git without a duplicate commit', async () => {
  const root = await vault(true); const executor = createMarkdownMemoryExecutor({ root, git: true });
  const { intent: made } = await prepareMemoryIntent({ root, view: isaac }, { action: 'create', request: { type: 'reference', title: 'G', tags: [], body: 'a\n' } });
  expect(await executor.execute(operation(made), control)).toMatchObject({ git: 'completed' });
  expect(commitCount(root)).toBe(2);
  const id = made.noteId;

  // Unrelated dirty work stays unstaged and uncommitted throughout.
  await writeFile(join(root, 'unrelated.txt'), 'keep\n');
  const { intent: a } = await prepareMemoryIntent({ root, view: isaac }, { action: 'append', noteId: id, append: 'b\n' });
  const opA = operation(a); await crash(root, opA, 'markdown', true);
  expect(commitCount(root)).toBe(2);
  expect(await executor.reconcile(opA, control)).toMatchObject({ status: 'succeeded', result: { git: 'completed' } });
  expect(commitCount(root)).toBe(3);
  expect(gitLog(root)).toContain('Memory-Operation:');
  expect(await executor.reconcile(opA, control)).toMatchObject({ status: 'succeeded', result: { git: 'completed' } });
  expect(commitCount(root)).toBe(3);

  const { intent: b } = await prepareMemoryIntent({ root, view: isaac }, { action: 'append', noteId: id, append: 'c\n' });
  const opB = operation(b); await crash(root, opB, 'git', true);
  expect(commitCount(root)).toBe(4);
  expect(await executor.reconcile(opB, control)).toMatchObject({ status: 'succeeded', result: { git: 'completed' } });
  expect(commitCount(root)).toBe(4);
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toContain('?? unrelated.txt');
  expect(execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' })).not.toContain('unrelated');
});

test('Git reconciliation reports uncertainty instead of staging or committing unrelated work', async () => {
  const root = await vault(true); const executor = createMarkdownMemoryExecutor({ root, git: true });
  const id = await (async () => { const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'create', request: { type: 'reference', title: 'U', tags: [], body: '' } });
    await executor.execute(operation(intent), control); return intent.noteId; })();
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'append', noteId: id, append: 'q\n' });
  const op = operation(intent); await crash(root, op, 'markdown', true);
  await writeFile(join(root, 'other.txt'), 'x\n'); execFileSync('git', ['add', 'other.txt'], { cwd: root });
  const before = commitCount(root);
  const result = await executor.reconcile(op, control);
  expect(result).toMatchObject({ status: 'succeeded', result: { git: 'uncertain' } });
  expect(commitCount(root)).toBe(before);
  expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim()).toBe('other.txt');
});

test('an unclean Git index rejects before the receipt and the Markdown effect', async () => {
  const root = await vault(true); const executor = createMarkdownMemoryExecutor({ root, git: true });
  await writeFile(join(root, 'staged.txt'), 'x\n'); execFileSync('git', ['add', 'staged.txt'], { cwd: root });
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'create', request: { type: 'reference', title: 'N', tags: [], body: '' } });
  await expect(executor.execute(operation(intent), control)).rejects.toThrow();
  await expect(readdir(join(root, 'references'))).rejects.toThrow();
  await expect(readdir(join(root, '.operations'))).rejects.toThrow();
});

test('delete refuses an external edit made after the receipt and stays uncertain', async () => {
  const root = await vault(); const id = await create(root);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'delete', noteId: id });
  const op = operation(intent); let edited = '';
  const executor = createMarkdownMemoryExecutor({ root, hooks: { afterReceipt: async () => { edited = `${await noteRaw(root, id)}edit\n`; await writeFile(join(root, 'references', `${id}.md`), edited); } } });
  const failure = await executor.execute(op, control).catch(error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.definitelyNotApplied).toBeUndefined();
  expect(await noteRaw(root, id)).toBe(edited);
  expect(await readdir(join(root, '.operations'))).toHaveLength(2);
  expect(await createMarkdownMemoryExecutor({ root }).reconcile(op, control)).toMatchObject({ status: 'unknown' });
});

test('lock acquisition failure is a proven pre-effect rejection', async () => {
  const root = await vault(); const id = await create(root);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'update', noteId: id, patch: { title: 'L' } });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, '.mutation-lock.sqlite')); db.exec('BEGIN IMMEDIATE');
  try {
    await expect(createMarkdownMemoryExecutor({ root }).execute(operation(intent), control)).rejects.toMatchObject({ definitelyNotApplied: true });
  } finally { db.exec('ROLLBACK'); db.close(); }
  await expect(readdir(join(root, '.operations'))).resolves.toHaveLength(1);
}, 15_000);

test('tampered, malformed or symlinked receipts are refused without outside reads', async () => {
  const root = await vault(); const id = await create(root);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'update', noteId: id, patch: { title: 'R' } });
  const op = operation(intent); const executor = createMarkdownMemoryExecutor({ root });
  await executor.execute(op, control);
  const dir = join(root, '.operations'); const [name] = (await readdir(dir)).filter(n => n.endsWith('.json')).sort();
  const files = (await readdir(dir)).filter(n => n.endsWith('.json'));
  const mine = (await Promise.all(files.map(async n => [n, JSON.parse(await readFile(join(dir, n), 'utf8'))] as const))).find(([, r]) => r.operationId === op.id)![0];
  void name;
  const path = join(dir, mine); const good = JSON.parse(await readFile(path, 'utf8'));
  for (const bad of [{ ...good, relativePath: '../outside.md' }, { ...good, effect: 'x' }, { ...good, git: 'yes' }, { ...good, gitOutcome: 'pending' }]) {
    await writeFile(path, JSON.stringify(bad));
    expect(await executor.reconcile(op, control), JSON.stringify(bad)).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/malformed/) });
  }
  await writeFile(path, JSON.stringify(good)); await writeFile(join(root, 'real.json'), JSON.stringify(good));
  await rm(path); await symlink(join(root, 'real.json'), path);
  expect(await executor.reconcile(op, control)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('Unsafe') });
});

test('a delete receipt with a tampered folder cannot fake success while the note exists', async () => {
  const root = await vault(); const id = await create(root);
  const { intent } = await prepareMemoryIntent({ root, view: isaac }, { action: 'delete', noteId: id });
  const op = operation(intent);
  await crash(root, op, 'receipt');
  const dir = join(root, '.operations'); const file = (await readdir(dir)).find(n => n.endsWith('.json'))!;
  const receipts = await Promise.all((await readdir(dir)).filter(n => n.endsWith('.json')).map(async n => [n, JSON.parse(await readFile(join(dir, n), 'utf8'))] as const));
  const [name, good] = receipts.find(([, r]) => r.operationId === op.id)!; void file;
  await writeFile(join(dir, name), JSON.stringify({ ...good, relativePath: `people/${id}.md` }));
  expect(await createMarkdownMemoryExecutor({ root }).reconcile(op, control)).toMatchObject({ status: 'unknown' });
});
