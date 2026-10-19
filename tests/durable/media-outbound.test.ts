import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { accept, admit, context, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { createMediaArtifactStore } from '../../src/durable/media-artifacts.js';
import { createNativeMediaOutbound, MediaOutbox, type MediaSender } from '../../src/durable/media-outbound.js';
import { createMediaSender } from '../../src/durable/media-outbound.js';
import { outboundMediaMethod, type MediaPort } from '../../src/durable/media-transport.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const dir = async () => { const path = await mkdtemp(join(tmpdir(), 'media-out-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; };
const envelope = (id = 1): SourceEnvelope => ({ instance: 'test', principal: 'person', bot: 'bot', chatId: 10, messageIds: [id], originalAt: 1700000000000 + id, content: `input ${id}` });

async function fixture(paths: string[], allow: (path: string) => Promise<string>, stateDir?: string) {
  const path = stateDir ?? await dir();
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
  faux.setResponses([answer(fauxToolCall('telegram_attach', { paths }), { stopReason: 'toolUse' }), answer('DONE')]);
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
  const store = createMediaArtifactStore({ root: join(path, 'out-media'), limits: { maxFileBytes: 50 * 1024 * 1024 } });
  let host: DurableHost | undefined;
  const outbound = createNativeMediaOutbound({ runtime: () => host!.runtime, store, authorize: async value => allow(value) });
  const registry = createRegistry(); registry.install(defineExtension({ name: 'media', tools: outbound.bundle.tools.map(item => item.tool) }));
  const text: string[] = [];
  host = await DurableHost.create({ stateDir: path, models, registry, agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'x' },
    compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' },
    transport: { async start() {}, async stop() {}, async sendFinal(request) { text.push(request.text); return { messageId: 50 }; } },
    policy: () => undefined, controlPolicy: () => undefined, settings: { retry: { enabled: false }, compaction: { enabled: false } } });
  cleanup.push(() => host!.close());
  return { host, outbound, store, text, path };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, e = envelope()) {
  await accept(f.host.runtime, e);
  const submission = await admit(f.host.runtime, e);
  await submission!.wait(context);
  await f.host.reconcile();
}
const files = async (names: string[]) => { const root = await dir(); const out: string[] = []; for (const name of names) { const p = join(root, name); await writeFile(p, `bytes of ${name}`); out.push(p); } return out; };
const state = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.host.runtime.harness.snapshot(MediaOutbox, f.host.runtime.root.id, context))!.items[sourceKey(envelope())]!.files;

it('queues copies through the authority check and sends each file once after the reply', async () => {
  const [a, b] = await files(['a.png', 'b.pdf']);
  const f = await fixture([a!, b!], async p => p);
  await run(f);
  expect((await state(f)).map(file => [file.name, file.status])).toEqual([['a.png', 'queued'], ['b.pdf', 'queued']]);
  // Source changes after queuing must not change what is sent.
  await writeFile(a!, 'mutated');
  const sent: Array<{ name: string; text: string; reply?: number }> = [];
  const send: MediaSender = async request => { sent.push({ name: request.file.name, text: Buffer.from(request.file.bytes).toString(), ...(request.replyToMessageId === undefined ? {} : { reply: request.replyToMessageId }) }); return { messageId: 100 + sent.length }; };
  await f.outbound.reconcile(send, async () => { throw new Error('no notice expected'); });
  await f.outbound.reconcile(send, async () => undefined);
  expect(sent).toEqual([{ name: 'a.png', text: 'bytes of a.png', reply: 1 }, { name: 'b.pdf', text: 'bytes of b.pdf', reply: 1 }]);
  expect((await state(f)).map(file => [file.status, file.messageId])).toEqual([['delivered', 101], ['delivered', 102]]);
  expect(await f.outbound.liveStoreKeys()).toEqual([]);
});

it('queues nothing when any path is refused', async () => {
  const [a, b] = await files(['a.txt', 'b.txt']);
  const f = await fixture([a!, b!], async p => { if (p === b) throw new Error('outside authority'); return p; });
  await run(f);
  const outbox = await f.host.runtime.harness.snapshot(MediaOutbox, f.host.runtime.root.id, context);
  expect(outbox?.items ?? {}).toEqual({});
  expect(await f.store.usage()).toBe(0);
});

it('does not queue a symlink or a directory', async () => {
  const [a] = await files(['a.txt']);
  const link = `${a}.link`; await symlink(a!, link);
  const f = await fixture([link], async p => p);
  await run(f);
  expect((await f.host.runtime.harness.snapshot(MediaOutbox, f.host.runtime.root.id, context))?.items ?? {}).toEqual({});
});

it('marks a crash during send uncertain, notifies once and never resends', async () => {
  const [a] = await files(['a.txt']);
  const f = await fixture([a!], async p => p);
  await run(f);
  // Simulate the host dying after the intent was committed.
  await f.host.runtime.root.commit(async tx => { (await tx.doc(MediaOutbox, f.host.runtime.root.id)).items[sourceKey(envelope())]!.files[0]!.status = 'sending'; }, context);
  let sends = 0; const notices: string[] = [];
  const send: MediaSender = async () => { sends++; return { messageId: 1 }; };
  for (let i = 0; i < 2; i++) await f.outbound.reconcile(send, async (_t, text) => { notices.push(text); });
  expect(sends).toBe(0);
  expect(notices).toEqual(['Telegram attachment a.txt may not have been delivered. It was not sent again.']);
  expect((await state(f))[0]).toMatchObject({ status: 'uncertain', notice: 'done' });
});

it('retries a definite failure up to the limit then reports Failed to send attachment', async () => {
  const [a] = await files(['a.txt']);
  const f = await fixture([a!], async p => p);
  await run(f);
  let sends = 0; const notices: string[] = [];
  const send: MediaSender = async () => { sends++; throw Object.assign(new Error('Telegram rejected the file (400).'), { definitelyNotSent: true }); };
  for (let i = 0; i < 5; i++) await f.outbound.reconcile(send, async (_t, text) => { notices.push(text); });
  expect(sends).toBe(3);
  expect(notices).toEqual(['Failed to send attachment a.txt: Telegram rejected the file (400).']);
});

it('treats an unacknowledged send as uncertain', async () => {
  const [a] = await files(['a.txt']);
  const f = await fixture([a!], async p => p);
  await run(f);
  let sends = 0; const notices: string[] = [];
  const send: MediaSender = async () => { sends++; throw new Error('timeout'); };
  for (let i = 0; i < 3; i++) await f.outbound.reconcile(send, async (_t, text) => { notices.push(text); });
  expect(sends).toBe(1);
  expect(notices).toHaveLength(1);
});

it('uploads through the port with legacy method selection and classifies rejections', async () => {
  expect(outboundMediaMethod('x.JPG').method).toBe('sendPhoto');
  expect(outboundMediaMethod('x.gif').method).toBe('sendPhoto');
  expect(outboundMediaMethod('x.pdf').method).toBe('sendDocument');
  const calls: Array<{ method: string; form: FormData }> = [];
  const respond = (value: { status: number; payload: unknown } | Error): MediaPort => ({ async call(method, body) { calls.push({ method, form: body as FormData }); if (value instanceof Error) throw value; return value as { status: number; payload: any }; }, async file() { throw new Error('unused'); } });
  const target = { chatId: 10, threadId: 3 };
  const ok = await createMediaSender(respond({ status: 200, payload: { ok: true, result: { message_id: 9 } } }), () => true)({ target, replyToMessageId: 4, file: { bytes: new Uint8Array([1]), name: 'a.png' }, identity: 'i' });
  expect(ok).toEqual({ messageId: 9 });
  expect(calls[0]!.method).toBe('sendPhoto');
  expect(calls[0]!.form.get('message_thread_id')).toBe('3');
  expect(calls[0]!.form.get('reply_parameters')).toBe('{"message_id":4}');
  const send = (value: Parameters<typeof respond>[0]) => createMediaSender(respond(value), () => true)({ target, file: { bytes: new Uint8Array([1]), name: 'a.txt' }, identity: 'i' }).catch((error: { definitelyNotSent?: boolean }) => error.definitelyNotSent);
  expect(await send({ status: 400, payload: { ok: false } })).toBe(true);
  expect(await send({ status: 502, payload: undefined })).toBe(false);
  expect(await send(new Error('net'))).toBe(false);
  expect(await send({ status: 200, payload: { ok: true, result: {} } })).toBe(false);
  expect(await createMediaSender(respond(new Error('unused')), () => false)({ target, file: { bytes: new Uint8Array(), name: 'a' }, identity: 'i' }).catch((e: { definitelyNotSent?: boolean }) => e.definitelyNotSent)).toBe(true);
});
