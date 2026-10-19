import { join } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineExtension, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createCanonicalMemoryDomain, createMemoryTool } from '../../../src/durable/memory.js';
import { MEMORY_EXECUTOR_NAME, MEMORY_EXECUTOR_VERSION, createMarkdownMemoryExecutor, prepareMemoryIntent, type MemoryExecutorHooks, type MemoryView } from '../../../src/durable/memory-executor.js';
import { createMemoryOperations, type MemoryOperation } from '../../../src/durable/operations.js';
export { context };

export const view: MemoryView = { principal: 'isaac', memoryView: 'owner-and-household' };
export type Live = { epoch: string; principal: string; presented: Array<{ operation: MemoryOperation; messageId: string }> };

/** Real Markdown vault, real executor, real pi-durable Harness and operation task; only Telegram presentation is synthetic. */
export async function open(dir: string, options: { hooks?: MemoryExecutorHooks } = {}) {
  const root = join(dir, 'vault');
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const live: Live = { epoch: 'epoch-1', principal: 'isaac', presented: [] };
  const env = { PI_TELEGRAM_MEMORY_DIR: root, PI_TELEGRAM_PRINCIPAL: view.principal, PI_TELEGRAM_MEMORY_VIEW: view.memoryView } as NodeJS.ProcessEnv;
  const domain = createCanonicalMemoryDomain({ env });
  const executor = createMarkdownMemoryExecutor({ root, hooks: options.hooks, env });
  const operations = createMemoryOperations({ executor, authority: { check: async op => op.binding.principal === live.principal } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'memory-integration', tasks: [operations.task] }));
  const db = await openNodeSqliteDatabase(join(dir, 'native.sqlite'));
  await db.exec('PRAGMA synchronous=FULL');
  const harness = await Harness.open(await SqliteStorage.open(db), { models: createModels(), registry }, context);
  const conversation = await harness.root(context);
  const tool = createMemoryTool({
    operations, domain, handler: { name: MEMORY_EXECUTOR_NAME, version: MEMORY_EXECUTOR_VERSION },
    prepareIntent: input => prepareMemoryIntent({ root, view }, input),
    resolveBinding: async () => ({ principal: live.principal, target: { chatId: 'chat', threadId: null }, epoch: live.epoch }),
    presenter: { present: async request => { const messageId = `message-${live.presented.length + 1}`; live.presented.push({ operation: request.operation, messageId }); return { messageId }; } },
  });
  const api = { conversationId: conversation.id, commit: (fn: never, ctx: never) => conversation.commit(fn, ctx), waitForTask: (id: never, ctx: never) => harness.waitForTask(id, ctx) } as unknown as ToolExecutionApi;
  return {
    root, live, harness, conversation, operations,
    call: async (args: Record<string, unknown>) => {
      const result = await tool.tool.execute(args as never, api, context);
      return JSON.parse((result.output?.[0] as { text: string }).text) as { ok: boolean; status: string; result?: any; error?: { code: string; message: string } };
    },
    close: async () => { await harness.close(context); },
  };
}
export type App = Awaited<ReturnType<typeof open>>;
