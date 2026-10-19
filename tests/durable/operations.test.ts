import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MemoryOperations, type MemoryOperationOutcome } from '../../src/durable/operations.js';
import type { TaskId } from '@earendil-works/pi-durable';
import { open, prepare, approve, context } from './fixtures/operations-runtime.js';
const dirs: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
  children.clear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'memory-operations-')); dirs.push(dir); return dir; }
test('presentation and decision are distinct; same epoch survives reopen and callbacks are one use', async () => {
  const dir = await directory(); let app = await open(dir); const op = await prepare(app); await app.close();
  app = await open(dir);
  try {
    const state = await app.harness.snapshot(MemoryOperations, app.root.id, context);
    expect(state?.operations[0]?.approval).toMatchObject({ presentation: { messageId: 'message' }, decision: null });
    for (const bad of [{ principal: 'wrong' }, { target: { chatId: 'wrong', threadId: 'topic' } }, { target: { chatId: 'chat', threadId: null } }, { messageId: 'wrong' }, { token: 'wrong' }]) expect(await approve(app, op, bad)).toEqual({ accepted: false });
    const accepted = await approve(app, op); expect(accepted.accepted).toBe(true);
    expect(await approve(app, op)).toEqual({ accepted: false });
    if (!accepted.accepted || !accepted.taskId) throw new Error('Not accepted');
    await app.harness.waitForTask(accepted.taskId, context);
    expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(1);
  } finally { await app.close(); }
  app = await open(dir);
  try { expect(await approve(app, op)).toEqual({ accepted: false }); await app.harness.waitForIdle(context); expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(1); } finally { await app.close(); }
});
for (const rejection of ['deny', 'new', 'reload', 'reset', 'failed', 'expired', 'revision', 'authority', 'version', 'fingerprint', 'unpresented'] as const) test(`rejects ${rejection} without an effect`, async () => {
  const app = await open(await directory());
  try {
    const op = await prepare(app);
    await app.root.commit(async tx => {
      const stored = (await tx.doc(MemoryOperations, app.root.id)).operations[0]!;
      if (rejection === 'new' || rejection === 'reload' || rejection === 'reset') await app.operations.invalidate(tx, app.root.id, 'new-epoch', rejection);
      if (rejection === 'failed') await app.operations.presentationFailed(tx, app.root.id, op.id);
      if (rejection === 'expired') app.clock.now = 500_000;
      if (rejection === 'revision') app.authority.revision = 'changed';
      if (rejection === 'authority') app.authority.allowed = false;
      if (rejection === 'version') stored.version = 2;
      if (rejection === 'fingerprint') stored.intent.noteId = 'changed';
      if (rejection === 'unpresented') stored.approval.presentation = null;
    }, context);
    const decision = await approve(app, op, rejection === 'deny' ? { choice: 'deny' } : {});
    expect(decision).toEqual(rejection === 'deny' ? { accepted: true, taskId: null } : { accepted: false });
    expect(await approve(app, op)).toEqual({ accepted: false });
    await app.harness.waitForIdle(context); expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(0);
  } finally { await app.close(); }
});
test('native task creation rolls back together with consumption', async () => {
  const app = await open(await directory());
  try {
    const op = await prepare(app);
    await expect(app.root.commit(async tx => {
      await app.operations.decide(tx, app.root.id, { token: op.approval.token, principal: 'actor', target: op.binding.target, messageId: 'message', choice: 'approve' });
      throw new Error('Injected commit failure');
    }, context)).rejects.toThrow('Injected');
    expect((await app.harness.snapshot(MemoryOperations, app.root.id, context))?.operations[0]?.approval.decision).toBeNull();
    const decision = await approve(app, op); expect(decision.accepted).toBe(true);
  } finally { await app.close(); }
});
for (const mode of ['authority', 'epoch', 'missing-executor', 'incompatible-executor', 'missing-task'] as const) test(`recovery checks ${mode} before effect`, async () => {
  const dir = await directory(); let app = await open(dir); const op = await prepare(app); const decision = await approve(app, op);
  if (!decision.accepted || !decision.taskId) throw new Error('Not accepted');
  if (mode === 'epoch') await app.root.commit(tx => app.operations.invalidate(tx, app.root.id, 'next', 'new'), context);
  await app.close(); app = await open(dir, { denied: mode === 'authority', missingExecutor: mode === 'missing-executor', handlerVersion: mode === 'incompatible-executor' ? 2 : 1, absentTask: mode === 'missing-task' });
  try {
    if (mode === 'missing-task') { expect(JSON.stringify(await app.harness.inspect(context))).toContain('assistant.memory-operation'); }
    else { await app.harness.waitForTask(decision.taskId, context); expect((await app.harness.snapshot(MemoryOperations, app.root.id, context))?.operations[0]?.status).toBe(mode.endsWith('executor') ? 'blocked' : 'interrupted'); }
    expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(0);
  } finally { await app.close(); }
});
for (const missing of [false, true]) test(`SIGKILL after effect before result reconciles ${missing ? 'unknown conservatively' : 'receipt without repetition'}`, async () => {
  const dir = await directory();
  const child = fork(fileURLToPath(new URL('./fixtures/operations-worker.ts', import.meta.url)), [dir, missing ? 'missing' : 'receipt'], { execArgv: ['--import', fileURLToPath(new URL('./fixtures/operations-loader.mjs', import.meta.url))], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.add(child);
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const taskId = await new Promise<TaskId<MemoryOperationOutcome>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No crash barrier: ${stderr}`)), 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Premature exit: ${stderr}`)); });
    child.on('message', (message: unknown) => { const event = message as { event: string; taskId: TaskId<MemoryOperationOutcome> }; if (event.event === 'effect') { clearTimeout(timeout); resolve(event.taskId); } });
  });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; children.delete(child);
  for (let i = 0; i < 2; i++) {
    const app = await open(dir);
    try {
      if (i === 0) expect((await app.harness.snapshot(MemoryOperations, app.root.id, context))?.operations[0]?.status).toBe('executing');
      await app.harness.waitForTask(taskId, context);
      expect((await app.harness.snapshot(MemoryOperations, app.root.id, context))?.operations[0]?.status).toBe(missing ? 'uncertain' : 'succeeded');
      expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(1);
    } finally { await app.close(); }
  }
}, 20_000);
for (const action of ['create', 'update', 'append', 'share', 'delete'] as const) test(`direct authorization enforces ${action} approval policy`, async () => {
  const app = await open(await directory());
  try {
    const op = await prepare(app, action);
    await app.root.commit(async tx => { (await tx.doc(MemoryOperations, app.root.id)).operations[0]!.approval.presentation = null; }, context);
    app.authority.allowed = false;
    expect(await app.root.commit(tx => app.operations.authorize(tx, app.root.id, op.id), context)).toEqual({ accepted: false });
    app.authority.allowed = true;
    const decision = await app.root.commit(tx => app.operations.authorize(tx, app.root.id, op.id), context);
    if (action === 'share' || action === 'delete') expect(decision).toEqual({ accepted: false });
    else {
      expect(decision.accepted).toBe(true);
      if (!decision.accepted) throw new Error('Not authorized');
      await app.harness.waitForTask(decision.taskId, context);
      expect((await app.harness.snapshot(MemoryOperations, app.root.id, context))?.operations[0]?.status).toBe('succeeded');
      expect(await app.root.commit(tx => app.operations.authorize(tx, app.root.id, op.id), context)).toEqual({ accepted: false });
    }
    expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(action === 'share' || action === 'delete' ? 0 : 1);
  } finally { await app.close(); }
});

for (const mode of ['no-executor', 'wrong-version'] as const) test(`executing effect reopened with ${mode} stays uncertain`, async () => {
  const dir = await directory();
  const child = fork(fileURLToPath(new URL('./fixtures/operations-worker.ts', import.meta.url)), [dir, 'receipt'], { execArgv: ['--import', fileURLToPath(new URL('./fixtures/operations-loader.mjs', import.meta.url))], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.add(child);
  const taskId = await new Promise<TaskId<MemoryOperationOutcome>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No crash barrier')), 10_000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Premature exit')); });
    child.on('message', (message: unknown) => { const event = message as { event: string; taskId: TaskId<MemoryOperationOutcome> }; if (event.event === 'effect') { clearTimeout(timeout); resolve(event.taskId); } });
  });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; children.delete(child);
  const app = await open(dir, { missingExecutor: mode === 'no-executor', handlerVersion: mode === 'wrong-version' ? 2 : 1 });
  try {
    await app.harness.waitForTask(taskId, context);
    const state = await app.harness.snapshot(MemoryOperations, app.root.id, context);
    expect(state?.operations[0]).toMatchObject({ status: 'uncertain' });
    expect(state?.operations[0]?.reason).toContain('reconcile manually');
    expect(app.operations.inspect(state!)[0]?.reason).toContain('reconcile manually');
    expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(1);
  } finally { await app.close(); }
}, 20_000);
test('authority loss before the executor is interrupted and invokes no effect', async () => {
  const app = await open(await directory());
  try {
    const op = await prepare(app); app.authority.denyAfter = 1;
    const decision = await approve(app, op); if (!decision.accepted || !decision.taskId) throw new Error('Not accepted');
    await app.harness.waitForTask(decision.taskId, context);
    expect((await app.harness.snapshot(MemoryOperations, app.root.id, context))?.operations[0]?.status).toBe('interrupted');
    expect(app.external.prepare('SELECT COUNT(*) AS n FROM effects').get()?.n).toBe(0);
  } finally { await app.close(); }
});
test('result revision must match intended post revision; exposes persisted result', async () => {
  for (const bad of [false, true]) {
    const app = await open(await directory(), { badRevision: bad });
    try {
      const op = await prepare(app, 'update', 'post');
      await app.root.commit(async tx => { await app.operations.presented(tx, app.root.id, op.id, 'message'); }, context);
      const decision = await app.root.commit(tx => app.operations.authorize(tx, app.root.id, op.id), context);
      if (!decision.accepted) throw new Error('Not authorized');
      await app.harness.waitForTask(decision.taskId, context);
      const stored = (await app.harness.snapshot(MemoryOperations, app.root.id, context))?.operations[0];
      expect(stored?.status).toBe(bad ? 'uncertain' : 'succeeded');
      expect(stored?.result).toMatchObject({ receipt: 'receipt-1', git: 'not-requested', revision: bad ? 'other' : 'post' });
    } finally { await app.close(); }
  }
});
