import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { AgentDoc, createRegistry } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { createNativeControls, NativePreferences } from '../../src/durable/controls.js';
import { accept, Bindings, context } from '../../src/durable/ingress.js';
import type { NativeConfig } from '../../src/durable/config.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
async function setup(path?: string) {
 const directory = path ?? await mkdtemp(join(tmpdir(), 'native-controls-'));
 if (!path) cleanup.push(() => rm(directory, { recursive: true, force: true }));
 const faux = fauxProvider({ models: [{ id: 'one' }, { id: 'two', reasoning: true }] });
 faux.setResponses([fauxAssistantMessage('OK')]);
 const models = createModels(); models.setProvider(faux.provider);
 const host = await DurableHost.create({ stateDir: directory, models, registry: createRegistry(), agent: { model: { provider: faux.provider.id, modelId: 'one' }, thinkingLevel: 'off' }, compatibility: { runtimeGeneration: 'fixture', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture' }, policy() {}, controlPolicy() {}, transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } } });
 cleanup.push(() => host.close());
 const reload = vi.fn(async () => {}), invalidate = vi.fn(async () => {}), requestRestart = vi.fn();
 const controls = createNativeControls({ config: { transport: { botId: 123 } } as NativeConfig, host: () => host, models, reload, invalidate, requestRestart });
 return { directory, host, controls, models, reload, invalidate, requestRestart };
}
const request = (suffix: string) => `telegram-control:123:${suffix}`;
test('native model and thinking selection survives restart and supplies the next epoch template', async () => {
 const first = await setup();
 const secondModel = first.controls.models().find(model => model.label.includes('two')) ?? first.controls.models()[1]!;
 await first.controls.setModel(request('model'), secondModel.id);
 await first.controls.setThinking(request('thinking'), 'high');
 await first.host.close();
 const next = await setup(first.directory); await next.controls.restore();
 expect(await next.controls.status()).toMatchObject({ model: secondModel.id, thinking: 'high' });
 await expect(next.controls.setThinking(request('bad'), 'unsupported')).rejects.toThrow(/unavailable/);
 await accept(next.host.runtime, { instance: 'test', principal: 'isaac', bot: '123', chatId: 42, messageIds: [1], originalAt: 1, content: 'test' });
 const state = await next.host.runtime.harness.snapshot(Bindings, next.host.runtime.root.id, context);
 expect(await next.host.runtime.harness.snapshot(AgentDoc, state!.epochs['0']!, context)).toMatchObject({ model: { modelId: 'two' }, thinkingLevel: 'high' });
});
test('reload invalidates once; restart receipt prevents repeated shutdown and a lost notice acknowledgement is never resent', async () => {
 const first = await setup();
 await first.controls.reload(request('reload')); await first.controls.reload(request('reload'));
 expect(first.reload).toHaveBeenCalledTimes(1); expect(first.invalidate).toHaveBeenCalledTimes(1);
 const afterAcknowledgement = await first.controls.restart(request('restart'));
 // A failed offset acknowledgement drops the first deferred callback. Replayed
 // ingress must still restart after its later successful acknowledgement.
 const afterReplay = await first.controls.restart(request('restart'));
 expect(afterReplay).toBeTypeOf('function');afterReplay?.();afterAcknowledgement?.();
 expect(await first.controls.restart(request('restart'))).toBeUndefined();
 expect(first.requestRestart).toHaveBeenCalledTimes(1);
 await first.host.close();
 const next = await setup(first.directory); const send = vi.fn(async () => { throw new Error('lost ack'); });
 await next.controls.notifyRestart(send); await next.controls.notifyRestart(send); expect(send).toHaveBeenCalledTimes(1);
 await next.controls.restart(request('restart')); expect(next.requestRestart).not.toHaveBeenCalled();
 expect((await next.host.runtime.harness.snapshot(NativePreferences, next.host.runtime.root.id, context))!.restartNotice?.status).toBe('uncertain');
 await expect(next.controls.setModel(request('reload'), next.controls.models()[0]!.id)).rejects.toThrow(/identity conflict/);
});
test('restart replay before startup notification cannot request a second shutdown', async () => {
 const first = await setup();
 const callback = await first.controls.restart(request('startup-race')); callback?.();
 expect(first.requestRestart).toHaveBeenCalledTimes(1);
 await first.host.close();
 const next = await setup(first.directory); await next.controls.restore();
 expect(await next.controls.restart(request('startup-race'))).toBeUndefined();
 expect(next.requestRestart).not.toHaveBeenCalled();
 const send = vi.fn(async () => {});
 await next.controls.notifyRestart(send); await next.controls.notifyRestart(send);
 expect(send).toHaveBeenCalledTimes(1);
 expect((await next.host.runtime.harness.snapshot(NativePreferences, next.host.runtime.root.id, context))!.restartNotice?.status).toBe('done');
});
test('a busy rejected administrative command stays rejected when later replayed idle', async () => {
 const first = await setup();
 const envelope = { instance: 'test', principal: 'isaac', bot: '123', chatId: 42, messageIds: [1], originalAt: 1, content: 'test' };
 await accept(first.host.runtime, envelope);
 await expect(first.controls.reload(request('busy'))).rejects.toThrow(/pending/);
 first.host.runtime.store.inbox.remove((await import('../../src/durable/ingress.js')).sourceKey(envelope));
 await expect(first.controls.reload(request('busy'))).rejects.toThrow(/interrupted/);
 expect(first.reload).not.toHaveBeenCalled();
});

test('restart rejects a persisted model removed from the selected catalog without fallback', async () => {
 const first = await setup();
 await first.controls.setModel(request('removed-model'), first.controls.models()[1]!.id);
 await first.host.close();
 const next = await setup(first.directory);
 const provider = next.models.getProviders()[0]!;
 const only = provider.getModels().filter(model => model.id === 'one');
 next.models.setProvider({ ...provider, getModels: () => only, getAllModels: () => only });
 await expect(next.controls.restore()).rejects.toThrow('Stored model selection is unavailable');
 expect((await next.host.runtime.harness.snapshot(NativePreferences, next.host.runtime.root.id, context))!.choice?.modelId).toBe('two');
 expect(next.host.runtime.agent.model?.modelId).toBe('one');
});
