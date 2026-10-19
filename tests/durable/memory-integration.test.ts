import { afterEach, expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryOperations, type MemoryOperation } from '../../src/durable/operations.js';
import { decideMemoryCallback, invalidateMemoryState } from '../../src/durable/memory.js';
import { context, open, type App } from './fixtures/memory-integration-runtime.js';

const dirs: string[] = []; const apps: App[] = []; const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL'); children.clear();
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'memory-integration-')); dirs.push(dir); return dir; }
async function start(dir?: string) { const app = await open(dir ?? await directory()); apps.push(app); return app; }
const states = async (app: App): Promise<MemoryOperation[]> => (await app.harness.snapshot(MemoryOperations, app.conversation.id, context))!.operations;
const note = (app: App, id: string) => readFile(join(app.root, 'references', `${id}.md`), 'utf8');
async function seed(app: App, title = 'Seed') {
  const review = await app.call({ action: 'create', draft: { type: 'reference', title, body: 'one\n' } });
  if (!review.result) throw new Error(JSON.stringify(review));
  const saved = await app.call({ action: 'create', draftToken: review.result.draftToken });
  expect(saved).toMatchObject({ ok: true, status: 'saved' });
  return { id: saved.result.id as string, revision: saved.result.revision as string, token: review.result.draftToken as string };
}
const callback = (app: App, op: MemoryOperation, overrides: object = {}) => app.conversation.commit(tx => decideMemoryCallback(tx, app.operations, app.conversation.id,
  { token: op.approval.token, principal: 'isaac', target: { chatId: 'chat', threadId: null }, messageId: 'message-1', choice: 'approve', ...overrides }), context);

test('create then append through the real executor dedups identical retries and rejects a stale revision', async () => {
  const app = await start(); const seeded = await seed(app);
  expect(await note(app, seeded.id)).toContain('one');
  // The same draft token joins the original operation.
  expect((await app.call({ action: 'create', draftToken: seeded.token })).result.id).toBe(seeded.id);
  const args = { action: 'update', id: seeded.id, revision: seeded.revision, append: 'two\n' };
  const first = await app.call(args); const again = await app.call(args);
  expect([first.status, again.status]).toEqual(['saved', 'saved']);
  expect(again.result.receipt).toBe(first.result.receipt);
  expect((await note(app, seeded.id)).match(/two/g)).toHaveLength(1);
  const ops = await states(app);
  expect(ops.map(op => [op.intent.action, op.status])).toEqual([['create', 'succeeded'], ['append', 'succeeded']]);
  expect(ops[0]!.intent.payload).toHaveProperty('request');
  expect(ops[1]!.intent).toMatchObject({ preRevision: seeded.revision, postRevision: first.result.revision, payload: { append: 'two\n' } });
  expect(await app.call({ ...args, append: 'three\n' })).toMatchObject({ status: 'conflict', error: { code: 'REVISION_CONFLICT' } });
  expect(await note(app, seeded.id)).not.toContain('three');
  expect((await readdir(join(app.root, '.operations'))).length).toBe(2);
});

test('share and delete run only after the authenticated callback, with exact revisions', async () => {
  const app = await start(); const { id, revision } = await seed(app);
  const shareRequest = await app.call({ action: 'share', id, revision });
  expect(shareRequest.status).toBe('confirmation_required');
  expect(await note(app, id)).not.toContain('household');
  const shareOp = app.live.presented[0]!.operation;
  expect(shareOp.intent).toMatchObject({ action: 'share', preRevision: revision, payload: { patch: { scope: 'household' } } });
  expect(await callback(app, shareOp, { principal: 'emma' })).toEqual({ accepted: false });
  const accepted = await callback(app, shareOp);
  if (!accepted.accepted || !accepted.taskId) throw new Error('not accepted');
  await app.harness.waitForTask(accepted.taskId, context);
  expect(await note(app, id)).toContain('scope: "household"');
  const shared = (await states(app)).find(op => op.id === shareOp.id)!;
  expect(shared.status).toBe('succeeded');
  const read = await app.call({ action: 'read', id });
  await app.call({ action: 'delete', id, revision: shared.result!.revision });
  const deleteOp = app.live.presented[1]!.operation;
  const done = await callback(app, deleteOp, { messageId: 'message-2' });
  if (!done.accepted || !done.taskId) throw new Error('not accepted');
  await app.harness.waitForTask(done.taskId, context);
  await expect(note(app, id)).rejects.toThrow();
  expect(read.result.scope).toBe('household');
  expect((await states(app)).find(op => op.id === deleteOp.id)!.status).toBe('succeeded');
});

test('new epoch invalidates a pending confirmation and a changed note rejects it without a write', async () => {
  const app = await start(); const { id, revision } = await seed(app);
  await app.call({ action: 'delete', id, revision });
  const pending = app.live.presented[0]!.operation;
  app.live.epoch = 'epoch-2';
  await app.conversation.commit(tx => invalidateMemoryState(tx, app.operations, app.conversation.id, 'epoch-2', 'new'), context);
  expect(await callback(app, pending)).toEqual({ accepted: false });
  expect(await note(app, id)).toContain('one');
  // A note edited after confirmation was requested fails closed at the executor.
  const second = await seed(app, 'Other');
  await app.call({ action: 'delete', id: second.id, revision: second.revision });
  const request = app.live.presented[1]!.operation;
  const changed = await app.call({ action: 'update', id: second.id, revision: second.revision, append: 'edit\n' });
  expect(changed.status).toBe('saved');
  const stale = await callback(app, request, { messageId: 'message-2' });
  if (!stale.accepted || !stale.taskId) throw new Error('not accepted');
  await app.harness.waitForTask(stale.taskId, context);
  expect((await states(app)).find(op => op.id === request.id)!.status).toBe('interrupted');
  expect(await note(app, second.id)).toContain('edit');
});

test('SIGKILL after the Markdown rename recovers from the receipt on reopen without a second append', async () => {
  const dir = await directory(); let app = await start(dir);
  const { id, revision } = await seed(app); await app.close(); apps.length = 0;
  const child = fork(fileURLToPath(new URL('./fixtures/memory-integration-worker.ts', import.meta.url)), [dir, id, revision],
    { execArgv: ['--import', fileURLToPath(new URL('./fixtures/operations-loader.mjs', import.meta.url))], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child);
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = await once(child, 'exit'); children.delete(child);
  expect(exited[1], stderr).toBe('SIGKILL');
  for (let attempt = 0; attempt < 2; attempt++) {
    app = await start(dir);
    const ops = await states(app); const crashed = ops.find(op => op.intent.action === 'append')!;
    if (attempt === 0) expect(crashed.status).toBe('executing');
    await app.harness.waitForTask(crashed.taskId!, context);
    const settled = (await states(app)).find(op => op.id === crashed.id)!;
    expect(settled).toMatchObject({ status: 'succeeded', result: { revision: crashed.intent.postRevision } });
    expect((await note(app, id)).match(/crash-line/g)).toHaveLength(1);
    // Retrying the same request joins the settled operation; nothing is written twice.
    expect((await app.call({ action: 'update', id, revision, append: 'crash-line\n' })).status).toBe('saved');
    expect((await note(app, id)).match(/crash-line/g)).toHaveLength(1);
    await app.close(); apps.length = 0;
  }
}, 30_000);
