import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost, type HostConfig } from '../../src/durable/host.js';
import { accept, admit, context, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { createMediaArtifactStore } from '../../src/durable/media-artifacts.js';
import { createNativeInputAdapter } from '../../src/durable/media-ingest.js';
import { createMediaRetention, MEDIA_RETENTION_MS, MediaRetirement } from '../../src/durable/media-retention.js';
import { MediaOutbox } from '../../src/durable/media-outbound.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), 'media-retention-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
 let clock = 1000, pendingAlbum = false;
 const inbound = createMediaArtifactStore({ root: join(dir, 'media'), now: () => clock }), outbound = createMediaArtifactStore({ root: join(dir, 'media-out'), now: () => clock });
 const faux = fauxProvider({ tokensPerSecond: 1e9 }); faux.setResponses([answer('DONE')]);
 const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
 let host!: DurableHost, retention!: ReturnType<typeof createMediaRetention>;
 const config: HostConfig = { stateDir: join(dir, 'native'), models, registry: createRegistry(), agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Synthetic' }, compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture' }, transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } }, policy: async (envelope, phase) => { if (phase === 'recovery') await retention.validate(envelope); }, controlPolicy: () => {}, recoveryPreflight: async () => { await retention.reconcile(true); }, inputAdapter: createNativeInputAdapter(inbound), settings: { retry: { enabled: false }, compaction: { enabled: false } } };
 const open = async () => { host = await DurableHost.create(config); retention = createMediaRetention({ runtime: () => host.runtime, inbound, outbound, inboundPending: async () => pendingAlbum, now: () => clock }); };
 await open(); cleanup.push(() => host.close());
 const base: SourceEnvelope = { instance: 'fixture', principal: 'person', bot: 'bot', chatId: 10, messageIds: [1], originalAt: 1, content: 'Read the file' };
 const ref = await inbound.stage(sourceKey(base), 0, { kind: 'document', name: 'file.txt', image: false }, { bytes: Buffer.from('SYNTHETIC') });
 const envelope = { ...base, attachments: [ref as never] };
 const settle = async () => { await accept(host.runtime, envelope); const submission = await admit(host.runtime, envelope, config.inputAdapter); await submission!.wait(context); await host.reconcile(); await retention.reconcile(true); };
 return { inbound, outbound, ref, envelope, settle, host: () => host, retention: () => retention, advance: (ms: number) => { clock += ms; }, album: (pending: boolean) => { pendingAlbum = pending; }, reopen: async () => { await host.close(); await open(); } };
}
test('retirement commits a tombstone, removes settled bytes after seven days, and permits restart without replay', async () => {
 const f = await fixture(); await f.settle();
 await f.inbound.open(f.ref); f.advance(MEDIA_RETENTION_MS - 1); await f.retention().reconcile(true); await f.inbound.open(f.ref);
 f.advance(1); await f.retention().reconcile(true);
 await expect(f.inbound.open(f.ref)).rejects.toThrow('unavailable');
 const state = await f.host().runtime.harness.snapshot(MediaRetirement, f.host().runtime.root.id, context);
 expect(state!.sources[sourceKey(f.envelope)]!.retiredAt).not.toBeNull();
 await f.reopen(); await f.host().validateRecovery(); expect(f.host().runtime.store.inbox.pending()).toEqual([]);
 await accept(f.host().runtime, { ...f.envelope, messageIds: [2], attachments: [], content: 'New request after expiration' });
 await expect(f.retention().reconcile(true)).resolves.toBeUndefined();
});
test('pending source artifacts survive any age and missing bytes block startup before admission', async () => {
 const f = await fixture(); await accept(f.host().runtime, f.envelope);
 f.advance(2 * MEDIA_RETENTION_MS); await f.retention().reconcile(true); await f.inbound.open(f.ref);
 await f.inbound.retire(sourceKey(f.envelope));
 await expect(f.host().validateRecovery()).rejects.toThrow('unavailable'); expect(f.host().runtime.store.inbox.pending()).toHaveLength(1);
});
test('new queued work in the same conversation protects previously settled file references', async () => {
 const f = await fixture(); await f.settle();
 await accept(f.host().runtime, { ...f.envelope, messageIds: [2], attachments: [], content: 'Read the earlier file again' });
 f.advance(2 * MEDIA_RETENTION_MS); await f.retention().reconcile(true); await f.inbound.open(f.ref);
 expect((await f.host().runtime.harness.snapshot(MediaRetirement, f.host().runtime.root.id, context))!.sources[sourceKey(f.envelope)]).toBeUndefined();
});
test('retiring outbound bytes preserves unknown effect receipts and protects queued files', async () => {
 const f = await fixture(); await f.settle();
 const unknown = await f.outbound.stage('unknown', 0, { kind: 'outbound', name: 'result.txt', image: false }, { bytes: Buffer.from('RESULT') });
 const queued = await f.outbound.stage('queued', 0, { kind: 'outbound', name: 'later.txt', image: false }, { bytes: Buffer.from('LATER') });
 await f.host().runtime.root.commit(async tx => { (await tx.doc(MediaOutbox, f.host().runtime.root.id)).items[sourceKey(f.envelope)] = { files: [
 { id: 'unknown', storeKey: 'unknown', ref: unknown, name: 'result.txt', status: 'uncertain', attempts: 1, notice: 'done' },
 { id: 'queued', storeKey: 'queued', ref: queued, name: 'later.txt', status: 'queued', attempts: 0, notice: 'none' }
 ] }; }, context);
 await f.retention().reconcile(true); f.advance(MEDIA_RETENTION_MS); await f.retention().reconcile(true);
 await expect(f.outbound.open(unknown)).rejects.toThrow('unavailable'); await f.outbound.open(queued);
 expect((await f.host().runtime.harness.snapshot(MediaOutbox, f.host().runtime.root.id, context))!.items[sourceKey(f.envelope)]!.files[0]!.status).toBe('uncertain');
});
test('journaled album work protects old staged copies until acceptance or visible rejection', async () => {
 const f = await fixture(); await f.settle();
 f.album(true); f.advance(MEDIA_RETENTION_MS); await f.retention().reconcile(true); await f.inbound.open(f.ref);
 f.album(false); await f.retention().reconcile(true); await expect(f.inbound.open(f.ref)).rejects.toThrow('unavailable');
 f.album(true); await expect(f.retention().reconcile(true)).resolves.toBeUndefined();
});
