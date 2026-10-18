import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { accept, admit, context, type SourceEnvelope } from '../../src/durable/ingress.js';
import { createMediaArtifactStore } from '../../src/durable/media-artifacts.js';
import { createNativeInputAdapter } from '../../src/durable/media-ingest.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

it('admits a source with real image content built from its verified artifacts', async () => {
  const path = await mkdtemp(join(tmpdir(), 'media-adm-')); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } }); faux.setResponses([answer('SEEN')]);
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
  const host = await DurableHost.create({ stateDir: path, models, registry: createRegistry(), agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'x' },
    compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' },
    transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } },
    policy: () => undefined, controlPolicy: () => undefined, settings: { retry: { enabled: false }, compaction: { enabled: false } } });
  cleanup.push(() => host.close());
  const store = createMediaArtifactStore({ root: join(path, 'media') });
  const base: SourceEnvelope = { instance: 'test', principal: 'person', bot: 'bot', chatId: 10, messageIds: [5], originalAt: 1700000000000, content: 'look' };
  const { sourceKey } = await import('../../src/durable/ingress.js');
  const ref = await store.stage(sourceKey(base), 0, { kind: 'photo', name: 'p.png', image: true, mimeType: 'image/png' }, { bytes: png });
  const envelope = { ...base, attachments: [ref as never] };
  await accept(host.runtime, envelope);
  const submission = await admit(host.runtime, envelope, createNativeInputAdapter(store));
  await host.reconcile();
  await submission!.wait(context);
  const { Bindings } = await import('../../src/durable/ingress.js');
  const state = await host.runtime.harness.snapshot(Bindings, host.runtime.root.id, context);
  const conversation = (await host.runtime.harness.conversation(Object.values(state!.sources)[0]!.conversationId, context))!;
  const seen = JSON.stringify((await conversation.context(context)).messages);
  expect(seen).toContain('"type":"image"');
  expect(seen).toContain('look');
});

it('fails admission closed when an artifact is missing', async () => {
  const path = await mkdtemp(join(tmpdir(), 'media-adm-')); cleanup.push(() => rm(path, { recursive: true, force: true }));
  const store = createMediaArtifactStore({ root: join(path, 'media') });
  const base: SourceEnvelope = { instance: 'test', principal: 'person', bot: 'bot', chatId: 10, messageIds: [5], originalAt: 1, content: 'x' };
  const { sourceKey } = await import('../../src/durable/ingress.js');
  const ref = await store.stage(sourceKey(base), 0, { kind: 'photo', name: 'p.png', image: true, mimeType: 'image/png' }, { bytes: png });
  await store.retire(sourceKey(base));
  await expect(createNativeInputAdapter(store)({ ...base, attachments: [ref as never] }, 'x')).rejects.toThrow('unavailable');
});
