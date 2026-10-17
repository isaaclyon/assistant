import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost, type HostControl } from '../../src/durable/host.js';
import { Bindings, context, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { createHarnessHistoryStore } from '../../src/durable/history.js';
import { createNativeSearch } from '../../src/durable/search.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const envelope = (id: number, content: string, principal = 'person'): SourceEnvelope => ({ instance: 'test', principal, bot: 'bot', chatId: 10, threadId: 2, messageIds: [id], originalAt: 1_700_000_000_000 + id * 1000, content });
const control = (type: HostControl['type'], requestId: string): HostControl => ({ type, requestId, principal: 'person', target: { chatId: 10, threadId: 2 } });

async function open(path: string, responses: ReturnType<typeof answer>[] = []) {
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
  const h = await DurableHost.create({
    stateDir: path, models, registry: createRegistry(), agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Synthetic host' },
    compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' },
    transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } },
    policy: e => { if (e.principal !== 'person') throw new Error('Unauthorized'); }, controlPolicy: c => { if (c.principal !== 'person') throw new Error('Unauthorized'); },
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  });
  cleanup.push(() => h.close());
  return h;
}
async function turn(h: DurableHost, e: SourceEnvelope) {
  await h.receive(e); await h.reconcile();
  const state = await h.runtime.harness.snapshot(Bindings, h.runtime.root.id, context);
  const id = state!.sources[sourceKey(e)]!.submissionId!;
  await (await h.runtime.harness.submission(id, context))!.wait(context);
}
const search = (h: DurableHost, state: string, principal = 'person') => {
  const store = createHarnessHistoryStore(h.runtime, { instanceId: 'test', storeId: 'main', principal });
  const service = createNativeSearch({ stateDir: state, instanceId: 'test', principalId: principal, memoryView: 'none', vaultRoot: join(state, 'vault'), resourceRoot: process.cwd(), stores: () => [store] });
  cleanup.push(() => service.close());
  return service;
};
type Found = { results: Array<{ sessionId: string; entryId: string; role: string; timestamp: string }> };

test('real host history is searchable, bounded by principal, and stable across /new and restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'history-host-')); cleanup.push(() => rm(path, { recursive: true, force: true }));
  let h = await open(path, [answer('Noted the pomegranate order'), answer('Second answer about figs')]);
  await turn(h, envelope(1, 'Please remember the pomegranate order'));
  let service = search(h, path);
  const first = (await service.sessionSearch({ query: 'pomegranate' })).result as Found;
  expect(first.results.map(r => r.role).sort()).toEqual(['assistant', 'user']);
  const user = first.results.find(r => r.role === 'user')!;
  expect(user.timestamp).toBe(new Date(1_700_000_001_000).toISOString());
  // Hidden turn state (system prompt, recall) never matches.
  expect(((await service.sessionSearch({ query: 'Synthetic host' })).result as Found).results).toEqual([]);
  // Another principal sees nothing from this store.
  expect(((await search(h, path, 'stranger').sessionSearch({ query: 'pomegranate' })).result as Found).results).toEqual([]);

  await h.control(control('new', 'new-1'));
  await turn(h, envelope(2, 'Now discuss figs'));
  const both = (await service.sessionSearch({ query: 'pomegranate OR figs' })).result as Found;
  expect(new Set(both.results.map(r => r.sessionId)).size).toBe(2);
  // The pre-/new citation still resolves with the same anchors.
  const context1 = await service.sessionContext({ sessionId: user.sessionId, entryId: user.entryId });
  expect(context1.ok).toBe(true);
  expect(await service.provenanceResolver([{ sessionId: user.sessionId, entryId: user.entryId, timestamp: user.timestamp }])).toEqual([null]);

  await h.close();
  h = await open(path);
  service = search(h, path);
  const after = (await service.sessionSearch({ query: 'pomegranate OR figs' })).result as Found;
  expect(after.results.map(r => `${r.sessionId}/${r.entryId}`).sort()).toEqual(both.results.map(r => `${r.sessionId}/${r.entryId}`).sort());
  expect(await service.provenanceResolver([{ sessionId: user.sessionId, entryId: user.entryId, timestamp: user.timestamp }])).toEqual([null]);
  expect(await service.provenanceResolver([{ sessionId: user.sessionId, entryId: user.entryId, timestamp: '2020-01-01T00:00:00.000Z' }])).toEqual(['SOURCE_TIMESTAMP_MISMATCH']);
});
