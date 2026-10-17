import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createMemoryOperations, type MemoryOperationExecutor, type MemoryOperation, type MemoryResult } from '../../../src/durable/operations.js';
export { context };
export const result: MemoryResult = { revision: 'post', receipt: 'receipt-1', git: 'not-requested' };
export async function open(dir: string, options: { crash?: boolean; missing?: boolean; denied?: boolean; missingExecutor?: boolean; handlerVersion?: number; absentTask?: boolean; badRevision?: boolean } = {}) {
  const external = new DatabaseSync(join(dir, 'external.sqlite'));
  external.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt INTEGER NOT NULL)');
  const executor: MemoryOperationExecutor = {
    name: 'fixture-memory', version: options.handlerVersion ?? 1,
    async execute(op, control) {
      await control.assertAuthority();
      external.prepare('INSERT INTO effects VALUES (?,?,?)').run(op.id, op.fingerprint, options.missing ? 0 : 1);
      if (options.crash) { process.send?.({ event: 'effect', taskId: op.taskId }); await new Promise(() => {}); }
      return options.badRevision ? { ...result, revision: 'other' } : result;
    },
    async reconcile(op) {
      const row = external.prepare('SELECT fingerprint, receipt FROM effects WHERE id=?').get(op.id);
      return row?.fingerprint === op.fingerprint && row.receipt === 1 ? { status: 'succeeded', result } : { status: 'unknown', reason: 'No matching domain receipt' };
    },
  };
  const authority = { allowed: !options.denied, revision: 'pre', checks: 0, denyAfter: Infinity };
  const clock = { now: 1_001 };
  const operations = createMemoryOperations({ executor: options.missingExecutor ? undefined : executor, now: () => clock.now, authority: { check: async (op, mode) => ++authority.checks <= authority.denyAfter && authority.allowed && (mode === 'reconcile' || op.intent.preRevision === authority.revision) } });
  const registry = createRegistry();
  if (!options.absentTask) registry.install(defineExtension({ name: 'memory-fixture', tasks: [operations.task] }));
  const db = await openNodeSqliteDatabase(join(dir, 'native.sqlite'));
  await db.exec('PRAGMA synchronous=FULL');
  const harness = await Harness.open(await SqliteStorage.open(db), { models: createModels(), registry }, context);
  const root = await harness.root(context);
  return { operations, root, harness, authority, clock, external, close: async () => { await harness.close(context); external.close(); } };
}
export type App = Awaited<ReturnType<typeof open>>;
export async function prepare(app: App, action: MemoryOperation['intent']['action'] = 'delete', postRevision: string | null = null) {
  return app.root.commit(async tx => {
    const op = await app.operations.prepare(tx, app.root.id, { id: 'op-1', binding: { principal: 'actor', target: { chatId: 'chat', threadId: 'topic' }, epoch: 'epoch' }, intent: { action, noteId: 'note-1', timestamp: '2026-01-01T00:00:00Z', preRevision: 'pre', postRevision, payload: {} }, handler: { name: 'fixture-memory', version: 1 }, expiresAt: 500_000 });
    await app.operations.presented(tx, app.root.id, op.id, 'message');
    return op;
  }, context);
}
export async function approve(app: App, op: MemoryOperation, overrides: Partial<Parameters<App['operations']['decide']>[2]> = {}) {
  return app.root.commit(tx => app.operations.decide(tx, app.root.id, { token: op.approval.token, principal: 'actor', target: { chatId: 'chat', threadId: 'topic' }, messageId: 'message', choice: 'approve', ...overrides }), context);
}
