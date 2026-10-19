import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryOperations } from '../../src/durable/operations.js';
import { MemoryDrafts, decideMemoryCallback, invalidateMemoryState, memoryToolParameters, memoryOperationParameters } from '../../src/durable/memory.js';
import { SEED, context, open, type App } from './memory-tool-fixture.js';

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'memory-tool-')); dirs.push(dir); return dir; }
async function start(dir?: string, controls?: Parameters<typeof open>[1]) { const app = await open(dir ?? await directory(), controls); apps.push(app); return app; }
async function operationState(app: App) { return (await app.harness.snapshot(MemoryOperations, app.root.id, context))!; }
const draft = { type: 'reference', title: 'Wi-Fi', body: 'password on fridge' };
async function review(app: App) { const r = await app.call({ action: 'create', draft }); expect(r.status).toBe('review_required'); return r.result.draftToken as string; }
const callback = (app: App, token: string, messageId: string, overrides: object = {}) => app.root.commit(tx => decideMemoryCallback(tx, app.operations, app.root.id,
  { token, principal: 'actor', target: { chatId: 'chat', threadId: null }, messageId, choice: 'approve', ...overrides }), context);

test('keeps the standard schema surface', () => {
  expect(memoryToolParameters).toMatchObject({ type: 'object' });
  for (const unsupported of ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not']) expect(memoryToolParameters).not.toHaveProperty(unsupported);
  const branches = (memoryOperationParameters as unknown as { anyOf: Array<{ properties: Record<string, { const?: string }>; additionalProperties: boolean }> }).anyOf;
  expect(branches.map(b => [b.properties.action!.const, Object.keys(b.properties).sort().join(',')])).toEqual([
    ['read', 'action,id'], ['create', 'action,draft'], ['create', 'action,draftToken'], ['update', 'action,append,edits,id,revision,set'],
    ['list', 'action,cursor,limit,statuses,types'], ['delete', 'action,id,revision'], ['share', 'action,id,revision']]);
  expect(branches.every(b => b.additionalProperties === false)).toBe(true);
});

test('flat provider arguments retain exact action validation before effects', async () => {
  const app = await start();
  for (const args of [
    { action: 'read' }, { action: 'delete', id: SEED },
    { action: 'create', draft, draftToken: SEED },
    { action: 'read', id: SEED, append: 'not a read argument' },
  ]) expect(await app.call(args)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(app.vault().effects).toEqual([]);
  expect(app.c.presented).toEqual([]);
});

test('draft survives restart in one epoch, is consumed once, and retries share the result', async () => {
  const dir = await directory(); let app = await start(dir);
  const token = await review(app); await app.close();
  app = await start(dir);
  const [a, b] = await Promise.all([app.call({ action: 'create', draftToken: token }), app.call({ action: 'create', draftToken: token })]);
  expect([a.status, b.status]).toEqual(['saved', 'saved']);
  expect(a.result.id).toBe(b.result.id);
  const again = await app.call({ action: 'create', draftToken: token });
  expect(again.result.id).toBe(a.result.id);
  expect(Object.keys(app.vault().notes)).toHaveLength(2);
  expect(app.vault().effects).toHaveLength(1);
  expect((await app.harness.snapshot(MemoryDrafts, app.root.id, context))!.drafts[0]!.consumed).not.toBeNull();
});

test('duplicate review lists related notes and keeps approval tokens out of model output', async () => {
  const app = await start();
  const first = await app.call({ action: 'create', draft: { ...draft, title: 'Seed' } });
  expect(first.result.possibleDuplicates).toEqual([{ id: SEED, title: 'Seed' }]);
  const token = await review(app); await app.call({ action: 'create', draftToken: token });
  const del = await app.call({ action: 'delete', id: SEED, revision: app.vault().notes[SEED]!.revision });
  const secret = app.c.presented[0]!.token;
  for (const text of [first.text, del.text]) expect(text).not.toContain(secret);
  expect(JSON.stringify(await operationState(app))).toContain(secret); // held only in trusted state
});

for (const reason of ['expired', 'new-epoch', 'principal', 'authority'] as const) test(`rejects a draft after ${reason} without an effect`, async () => {
  const app = await start(); const token = await review(app);
  if (reason === 'expired') app.c.now += 10 * 60_000 + 1;
  if (reason === 'new-epoch') { app.c.epoch = 'epoch-2'; await app.root.commit(tx => invalidateMemoryState(tx, app.operations, app.root.id, 'epoch-2', 'new'), context); }
  if (reason === 'principal') app.c.principal = 'someone';
  if (reason === 'authority') app.c.authority = false;
  const result = await app.call({ action: 'create', draftToken: token });
  expect(result.ok).toBe(false); expect(result.error!.code).toBe('STALE_ACTION');
  expect(app.vault().effects).toHaveLength(0);
  expect((await app.call({ action: 'create', draftToken: 'bad' })).ok).toBe(false);
});

test('a consumed token cannot be replayed by another principal', async () => {
  const app = await start(); const token = await review(app);
  expect((await app.call({ action: 'create', draftToken: token })).status).toBe('saved');
  app.c.principal = 'intruder';
  expect((await app.call({ action: 'create', draftToken: token })).error?.code).toBe('STALE_ACTION');
});

test('update joins identical in-flight and settled requests and rejects stale revisions', async () => {
  const app = await start(); const revision = app.vault().notes[SEED]!.revision;
  const args = { action: 'update', id: SEED, revision, append: ' two' };
  const [a, b] = await Promise.all([app.call(args), app.call(args)]);
  expect(a.status).toBe('saved'); expect(b.status).toBe('saved');
  expect(app.vault().effects).toHaveLength(1); expect(app.vault().notes[SEED]!.body).toBe('one two');
  expect((await app.call(args)).status).toBe('saved'); expect(app.vault().effects).toHaveLength(1);
  const stale = await app.call({ action: 'update', id: SEED, revision: 'sha256:' + '0'.repeat(64), append: 'x' });
  expect(stale).toMatchObject({ status: 'conflict', error: { code: 'REVISION_CONFLICT' } });
  expect((await app.call({ action: 'update', id: SEED, revision: app.vault().notes[SEED]!.revision })).error?.code).toBe('INVALID_INPUT');
});

test('a crash after the effect reports uncertainty and never repeats the write', async () => {
  const app = await start(undefined, { throwAfterEffect: true }); const revision = app.vault().notes[SEED]!.revision;
  const args = { action: 'update', id: SEED, revision, append: ' two' };
  const first = await app.call(args);
  expect(first).toMatchObject({ ok: false, status: 'uncertain', error: { code: 'OUTCOME_UNCERTAIN' }, isError: true });
  app.c.throwAfterEffect = false;
  expect((await app.call(args)).status).toBe('uncertain');
  expect(app.vault().effects).toHaveLength(1);
});

test('a missing executor blocks without an effect', async () => {
  const app = await start(undefined, { noExecutor: true });
  const result = await app.call({ action: 'update', id: SEED, revision: app.vault().notes[SEED]!.revision, append: 'x' });
  expect(result.error?.code).toBe('UNAVAILABLE'); expect(app.vault().effects).toHaveLength(0);
});

test('delete and share need an authenticated one-use callback bound to principal, target and message', async () => {
  const app = await start(); const note = app.vault().notes[SEED]!;
  const request = await app.call({ action: 'delete', id: SEED, revision: note.revision });
  expect(request).toMatchObject({ ok: true, status: 'confirmation_required' });
  expect(app.vault().effects).toHaveLength(0);
  const { token, messageId, preview } = app.c.presented[0]!;
  expect(preview).toMatchObject({ title: 'Seed', type: 'reference' });
  for (const bad of [{ principal: 'other' }, { messageId: 'wrong' }, { target: { chatId: 'x', threadId: null } }, { token: 'wrong' }]) {
    expect(await callback(app, token, messageId, bad)).toEqual({ accepted: false });
  }
  const accepted = await callback(app, token, messageId);
  if (!accepted.accepted || !accepted.taskId) throw new Error('not accepted');
  await app.harness.waitForTask(accepted.taskId, context);
  expect(app.vault().notes[SEED]).toBeUndefined();
  expect(await callback(app, token, messageId)).toEqual({ accepted: false });
  expect(app.vault().effects).toHaveLength(1);
});

test('confirmation survives restart; deny, expiry, new epoch and changed revision never write', async () => {
  for (const mode of ['restart', 'deny', 'expired', 'epoch', 'revision'] as const) {
    const dir = await directory(); let app = await start(dir);
    await app.call({ action: 'share', id: SEED, revision: app.vault().notes[SEED]!.revision });
    const { token, messageId } = app.c.presented[0]!;
    if (mode === 'restart') { await app.close(); app = await start(dir); }
    if (mode === 'expired') app.c.now += 10 * 60_000 + 1;
    if (mode === 'epoch') { app.c.epoch = 'e2'; await app.root.commit(tx => invalidateMemoryState(tx, app.operations, app.root.id, 'e2', 'reset'), context); }
    if (mode === 'revision') { const v = app.vault(); v.notes[SEED]!.revision = 'changed'; app.save(v); }
    const decision = await callback(app, token, messageId, mode === 'deny' ? { choice: 'deny' } : {});
    if (decision.accepted && decision.taskId) await app.harness.waitForTask(decision.taskId, context);
    const op = (await operationState(app)).operations[0]!;
    if (mode === 'restart') { expect(decision.accepted).toBe(true); expect(op.status).toBe('succeeded'); expect(app.vault().notes[SEED]!.scope).toBe('household'); }
    else { expect(app.vault().effects).toHaveLength(0); expect(app.vault().notes[SEED]!.scope).toBe('personal'); expect(op.status).toBe(mode === 'expired' ? 'prepared' : 'interrupted'); if (mode === 'expired') expect(decision).toEqual({ accepted: false }); }
    await app.close(); apps.pop();
  }
});

test('failed presentation revokes the confirmation and writes nothing', async () => {
  const app = await start(undefined, { failPresent: true });
  const result = await app.call({ action: 'delete', id: SEED, revision: app.vault().notes[SEED]!.revision });
  expect(result.error?.code).toBe('PRESENTATION_FAILED');
  const op = (await operationState(app)).operations[0]!;
  expect(op.status).toBe('interrupted'); expect(op.approval.invalidated).toBe('presentation-failed');
  expect(app.vault().effects).toHaveLength(0);
});

test('delete/share validate revision and share requires a personal note', async () => {
  const app = await start();
  expect((await app.call({ action: 'delete', id: SEED, revision: 'sha256:' + '1'.repeat(64) })).status).toBe('conflict');
  const v = app.vault(); v.notes[SEED]!.scope = 'household'; app.save(v);
  expect((await app.call({ action: 'share', id: SEED, revision: v.notes[SEED]!.revision })).error?.code).toBe('INVALID_INPUT');
  expect(app.c.presented).toHaveLength(0);
});

test('read records usage and list paginates with a conflict-checked cursor', async () => {
  const app = await start();
  for (const title of ['A', 'B']) { const token = (await app.call({ action: 'create', draft: { ...draft, title } })).result.draftToken; await app.call({ action: 'create', draftToken: token }); }
  expect((await app.call({ action: 'read', id: SEED })).status).toBe('read'); expect(app.vault().reads).toEqual([SEED]);
  const page = await app.call({ action: 'list', limit: 2 });
  expect(page.result.memories).toHaveLength(2); expect(page.result.nextCursor).toBeTruthy();
  expect((await app.call({ action: 'list', limit: 2, cursor: page.result.nextCursor })).result.nextCursor).toBeNull();
  const v = app.vault(); delete v.notes[SEED]; app.save(v);
  expect((await app.call({ action: 'list', limit: 2, cursor: page.result.nextCursor })).error?.code).toBe('CURSOR_CONFLICT');
});
