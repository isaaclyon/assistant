import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineExtension, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createMemoryTool, type MemoryDomain, type MemoryNote } from '../../src/durable/memory.js';
import type { PrepareMemoryIntentInput } from '../../src/durable/memory-executor.js';
import { createMemoryOperations, type MemoryIntent, type MemoryOperation, type MemoryOperationExecutor } from '../../src/durable/operations.js';
export { context };

type Vault = { notes: Record<string, MemoryNote & { body: string }>; receipts: Record<string, { revision: string | null }>; effects: string[]; reads: string[] };
export const rev = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const NOTE = '11111111-1111-4111-8111-111111111111';
export const SEED = NOTE;

export type Controls = {
  principal: string; epoch: string; now: number; authority: boolean; failPresent: boolean; throwAfterEffect: boolean; noExecutor: boolean;
  presented: Array<{ token: string; operation: MemoryOperation; preview: unknown; messageId: string }>;
};
/** Disposable domain: a JSON vault file stands in for canonical Markdown so state survives close/reopen. */
export async function open(dir: string, controls?: Partial<Controls>) {
  const c: Controls = { principal: 'actor', epoch: 'epoch-1', now: 1_000_000, authority: true, failPresent: false, throwAfterEffect: false, noExecutor: false, presented: [], ...controls };
  const path = join(dir, 'vault.json');
  const load = (): Vault => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { notes: { [NOTE]: { id: NOTE, revision: rev('seed'), scope: 'personal', title: 'Seed', type: 'reference', updated: '2026-01-01', body: 'one' } }, receipts: {}, effects: [], reads: [] };
  const save = (v: Vault) => writeFileSync(path, JSON.stringify(v));
  const domain: MemoryDomain = {
    validateDraft: raw => raw as never,
    read: async id => { const note = load().notes[id]; if (!note) throw Object.assign(new Error('Memory not found'), { name: 'MemoryError', code: 'NOT_FOUND' }); return note; },
    list: async () => Object.values(load().notes).map(({ body: _b, ...n }) => n),
    findDuplicates: async draft => ({ results: Object.values(load().notes).filter(n => n.title === draft.title).map(n => ({ id: n.id, title: n.title })) }),
    recordRead: async id => { const v = load(); v.reads.push(id); save(v); },
  };
  const executor: MemoryOperationExecutor = {
    name: 'fixture-memory', version: 1,
    async execute(op, control) {
      await control.assertAuthority();
      const v = load(); const note = v.notes[op.intent.noteId];
      if (op.intent.action === 'create') v.notes[op.intent.noteId] ??= { id: op.intent.noteId, revision: op.intent.postRevision!, scope: 'personal', title: String((op.intent.payload.request as { title: string }).title), type: 'reference', updated: 'now', body: '' };
      else if (op.intent.action === 'delete') delete v.notes[op.intent.noteId];
      else if (op.intent.action === 'share') note!.scope = 'household', note!.revision = op.intent.postRevision!;
      else { const patch = (op.intent.action === 'append' ? op.intent.payload : op.intent.payload.patch) as { append?: string }; note!.body += patch.append ?? ''; note!.revision = op.intent.postRevision!; }
      v.effects.push(op.id); v.receipts[op.id] = { revision: v.notes[op.intent.noteId]?.revision ?? null };
      save(v);
      if (c.throwAfterEffect) throw new Error('crash after effect');
      return { revision: v.receipts[op.id]!.revision, receipt: op.id, git: 'not-requested' };
    },
    async reconcile(op) { const r = load().receipts[op.id]; return r ? { status: 'succeeded', result: { revision: r.revision, receipt: op.id, git: 'not-requested' } } : { status: 'unknown', reason: 'No matching receipt' }; },
  };
  const operations = createMemoryOperations({ executor: c.noExecutor ? undefined : executor, now: () => c.now, authority: { check: async (op, mode) => {
    if (!c.authority || op.binding.principal !== c.principal) return false;
    if (mode === 'execute' && op.intent.preRevision) { const note = load().notes[op.intent.noteId]; if (note?.revision !== op.intent.preRevision) return false; }
    return true;
  } } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'memory-fixture', tasks: [operations.task] }));
  const db = await openNodeSqliteDatabase(join(dir, 'native.sqlite'));
  await db.exec('PRAGMA synchronous=FULL');
  const harness = await Harness.open(await SqliteStorage.open(db), { models: createModels(), registry }, context);
  const root = await harness.root(context);
  const prepareIntent = async (input: PrepareMemoryIntentInput) => {
    const noteId = input.action === 'create' ? input.noteId ?? randomUUID() : input.noteId;
    const base = { noteId, timestamp: input.timestamp!, preRevision: input.action === 'create' ? null : load().notes[noteId]?.revision ?? 'sha256:missing', postRevision: input.action === 'delete' ? null : rev(`post-${noteId}-${input.timestamp}`) };
    const payload = input.action === 'create' ? { request: input.request } : input.action === 'append' ? { append: (input as { append: string }).append }
      : input.action === 'delete' ? {} : { patch: input.patch };
    return { intent: { ...base, action: input.action, payload } as MemoryIntent };
  };
  const tool = createMemoryTool({ operations, prepareIntent, handler: { name: 'fixture-memory', version: 1 }, domain, now: () => c.now,
    resolveBinding: async () => ({ principal: c.principal, target: { chatId: 'chat', threadId: null }, epoch: c.epoch }),
    presenter: { present: async request => {
      if (c.failPresent) throw new Error('telegram down');
      const messageId = `message-${c.presented.length + 1}`;
      c.presented.push({ token: request.operation.approval.token, operation: request.operation, preview: request.preview, messageId });
      return { messageId };
    } } });
  const api = { conversationId: root.id, commit: (fn: never, ctx: never) => root.commit(fn, ctx), waitForTask: (id: never, ctx: never) => harness.waitForTask(id, ctx) } as unknown as ToolExecutionApi;
  return {
    c, root, harness, operations, vault: load, save, api,
    call: async (args: Record<string, unknown>) => {
      const result = await tool.tool.execute(args as never, api, context);
      const text = (result.output?.[0] as { text: string }).text;
      return { ...JSON.parse(text), text, isError: result.isError } as { ok: boolean; status: string; result?: any; error?: { code: string; message: string }; text: string; isError?: boolean };
    },
    close: async () => { await harness.close(context); },
  };
}
export type App = Awaited<ReturnType<typeof open>>;
