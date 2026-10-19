import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { UnboundInboxError } from '../../src/durable/recovery.js';
import { accept, normalize, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const envelope = (id: number): SourceEnvelope => ({ instance: 'test', principal: 'person', bot: 'bot', chatId: 10, threadId: 2, messageIds: [id], originalAt: 1_700_000_000_000 + id, content: `SECRET-CONTENT ${id}` });

async function open(path: string, counters: { transportStarts: number }) {
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } }); faux.setResponses([answer('ANSWER')]);
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
  const host = await DurableHost.create({ stateDir: path, models, registry: createRegistry(), agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Synthetic host' },
    compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' },
    transport: { async start() { counters.transportStarts++; }, async stop() {}, async sendFinal() { return { messageId: 1 }; } },
    policy: () => {}, controlPolicy: () => {}, settings: { retry: { enabled: false }, compaction: { enabled: false } } });
  cleanup.push(() => host.close());
  return { host, faux };
}

it('refuses legacy, unparseable and unbound inbox rows before transport or execution and preserves bytes', async () => {
  const path = await mkdtemp(join(tmpdir(), 'durable-guard-')); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const first = await open(path, { transportStarts: 0 });
  await accept(first.host.runtime, envelope(1)); // native acceptance persists binding and row
  const nativeKey = sourceKey(normalize(envelope(1)));
  await first.host.close();
  const db = new DatabaseSync(join(path, 'inbox.db'));
  const unbound = normalize(envelope(2));
  db.prepare('INSERT INTO pending_turn VALUES (?,?,?)').run('10:77', JSON.stringify({ routing: { chatId: 10 }, text: 'SECRET-LEGACY' }), 1);
  db.prepare('INSERT INTO pending_turn VALUES (?,?,?)').run('10:78', 'SECRET-garbage', 2);
  db.prepare('INSERT INTO pending_turn VALUES (?,?,?)').run(sourceKey(unbound), JSON.stringify(unbound), 3);
  const before = db.prepare('SELECT id,payload,enqueued_at FROM pending_turn ORDER BY rowid').all();
  db.close();
  const counters = { transportStarts: 0 };
  const second = await open(path, counters);
  const error = await second.host.start().then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(UnboundInboxError);
  expect((error as UnboundInboxError).reasons).toEqual({ unparseable: 1, 'unrecognized-shape': 1, unbound: 1, changed: 0 });
  expect((error as Error).message).not.toMatch(/SECRET|10:77/);
  await expect(second.host.validateInbox()).rejects.toBeInstanceOf(UnboundInboxError);
  await expect(second.host.reconcile()).rejects.toBeInstanceOf(UnboundInboxError);
  expect(counters.transportStarts).toBe(0);
  expect(second.faux.state.callCount).toBe(0);
  expect((await second.host.inspect()).inspection.tasks).toEqual([]);
  await second.host.close();
  const check = new DatabaseSync(join(path, 'inbox.db'), { readOnly: true });
  expect(check.prepare('SELECT id,payload,enqueued_at FROM pending_turn ORDER BY rowid').all()).toEqual(before);
  expect(before.some(row => row.id === nativeKey)).toBe(true);
  check.close();
});

it('starts normally when every pending row has its native binding', async () => {
  const path = await mkdtemp(join(tmpdir(), 'durable-guard-')); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const counters = { transportStarts: 0 };
  const { host } = await open(path, counters);
  await accept(host.runtime, envelope(1));
  await host.validateInbox();
  await host.start();
  expect(counters.transportStarts).toBe(1);
});
