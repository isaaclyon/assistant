import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertMediaAttachments, createAlbumJournal, createMediaIngest, createNativeInputAdapter, type MediaIngestOptions } from '../../src/durable/media-ingest.js';
import { createMediaArtifactStore } from '../../src/durable/media-artifacts.js';
import type { MediaPort } from '../../src/durable/media-transport.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'media-ingest-')); roots.push(root); return root; };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const identity = { instance: 'test', principal: 'person', bot: 'bot' };

function fakePort(files: Record<string, Buffer | Error | { status: number; description: string }>) {
  const calls: string[] = [];
  const port: MediaPort = {
    async call(method, body) {
      calls.push(method);
      const id = (body as { file_id: string }).file_id, item = files[id];
      if (item instanceof Error) throw item;
      if (!item) return { status: 400, payload: { ok: false, description: 'bad' } };
      if ('status' in item) return { status: item.status, payload: { ok: false, description: item.description } };
      return { status: 200, payload: { ok: true, result: { file_path: `files/${id}`, file_size: item.length } } };
    },
    async file(path) { const item = files[path.slice(6)]; return new Response(item as unknown as Blob); },
  };
  return { port, calls };
}
async function setup(files: Parameters<typeof fakePort>[0], extra: Partial<MediaIngestOptions> = {}) {
  const root = await temp();
  const store = createMediaArtifactStore({ root: join(root, 'media') });
  const journal = createAlbumJournal(join(root, 'pending'));
  const fake = fakePort(files);
  const make = (now: () => number) => createMediaIngest({ identity, port: fake.port, store, journal, now, quietMs: 1000, ...extra });
  return { root, store, journal, fake, make };
}
const msg = (id: number, extra: Record<string, unknown>) => ({ message_id: id, date: 1700000000, chat: { id: 10 }, ...extra });
const photo = (id: string) => [{ file_id: id, file_size: 16, width: 1, height: 1 }];

it('stages a photo and a document, builds image blocks and verified read-only paths', async () => {
  const doc = Buffer.from('hello');
  const { store, make } = await setup({ p1: png, d1: doc });
  const ingest = make(() => 0);
  expect(await ingest.receive({ message_id: 3, date: 1, chat: { id: 10 }, text: 'plain' }, { updateId: 1 })).toEqual({ type: 'none' });
  const result = await ingest.receive(msg(5, { caption: 'look', photo: photo('p1') }), { updateId: 9 });
  expect(result.type).toBe('input');
  if (result.type !== 'input') return;
  const e = result.envelope;
  expect(e.messageIds).toEqual([5]);
  expect(e.content).toContain('look');
  expect(await assertMediaAttachments(e, store)).toHaveLength(1);
  const mixed = await ingest.receive(msg(6, { document: { file_id: 'd1', file_name: '../r.txt', mime_type: 'text/plain', file_size: 5 }, caption: 'doc' }), { updateId: 10 });
  if (mixed.type !== 'input') throw new Error('expected input');
  const adapted = await createNativeInputAdapter(store)(mixed.envelope, mixed.envelope.content);
  expect(typeof adapted).toBe('string');
  expect(adapted as string).toMatch(/read-only host-verified file copies/);
  expect(adapted as string).toContain(JSON.stringify((await store.verifiedPath(mixed.envelope.attachments![0]!)).path));
  expect(adapted as string).not.toContain('..');
  const blocks = await createNativeInputAdapter(store)(e, e.content);
  expect(Array.isArray(blocks) && blocks.some(block => block.type === 'image')).toBe(true);
});

it('rejects an attachment that belongs to another source', async () => {
  const { store, make } = await setup({ p1: png });
  const a = await make(() => 0).receive(msg(5, { photo: photo('p1') }), { updateId: 1 });
  if (a.type !== 'input') throw new Error('expected input');
  await expect(assertMediaAttachments({ ...a.envelope, messageIds: [6] }, store)).rejects.toThrow('does not belong');
});

it('refuses voice visibly without a provider and transcribes with one', async () => {
  const voice = Buffer.from('ogg');
  const one = await setup({ v1: voice });
  expect(await one.make(() => 0).receive(msg(5, { voice: { file_id: 'v1', file_size: 3 } }), { updateId: 1 })).toMatchObject({ type: 'rejected', reason: expect.stringContaining('no transcription provider') });
  expect(one.fake.calls).toEqual([]);
  const two = await setup({ v1: voice }, { voice: async () => 'hello there' });
  const result = await two.make(() => 0).receive(msg(5, { voice: { file_id: 'v1', file_size: 3 } }), { updateId: 1 });
  expect(result).toMatchObject({ type: 'input', envelope: { content: expect.stringContaining('hello there') } });
});

it('classifies download failures: permanent rejects, retryable rethrows until the attempt limit', async () => {
  const { make } = await setup({ big: { status: 400, description: 'file is too big' }, net: new Error('socket') });
  const ingest = make(() => 0);
  expect(await ingest.receive(msg(5, { document: { file_id: 'big' } }), { updateId: 1 })).toMatchObject({ type: 'rejected' });
  const request = () => ingest.receive(msg(6, { document: { file_id: 'net' } }), { updateId: 2 });
  await expect(request()).rejects.toThrow();
  await expect(request()).rejects.toThrow();
  expect(await request()).toMatchObject({ type: 'rejected', reason: expect.stringContaining('several attempts') });
});

it('journals album members before returning so a crash replays every member', async () => {
  const { root, journal, store, fake, make } = await setup({ a: png, b: png });
  let now = 0;
  const first = make(() => now);
  expect(await first.receive(msg(7, { media_group_id: 'g', photo: photo('a') }), { updateId: 1 })).toMatchObject({ type: 'pending' });
  expect(await first.receive(msg(8, { media_group_id: 'g', photo: photo('b') }), { updateId: 2 })).toMatchObject({ type: 'pending' });
  expect(fake.calls).toEqual([]); // nothing downloaded yet, but both members are durable
  now = 5000;
  // Restart: a new instance reads the journal.
  const second = make(() => now);
  expect(await second.recover()).toBeDefined();
  now = 7000;
  const due = await second.collect();
  expect(due.inputs).toHaveLength(1);
  expect(due.inputs[0]!.envelope.messageIds).toEqual([7, 8]);
  expect(due.inputs[0]!.envelope.attachments).toHaveLength(2);
  expect(await assertMediaAttachments(due.inputs[0]!.envelope, store)).toHaveLength(2);
  expect(await journal.list()).toHaveLength(2);
  await second.done([7, 8]);
  expect(await journal.list()).toHaveLength(0);
  void root;
});

it('keeps album members journaled when a download fails and retries them', async () => {
  const { journal, make, fake } = await setup({ a: png, b: new Error('offline') });
  let now = 0;
  const ingest = make(() => now);
  await ingest.receive(msg(7, { media_group_id: 'g', photo: photo('a') }), { updateId: 1 });
  await ingest.receive(msg(8, { media_group_id: 'g', photo: photo('b') }), { updateId: 2 });
  now = 2000;
  const first = await ingest.collect();
  expect(first.inputs).toEqual([]);
  expect(first.failed).toHaveLength(1);
  expect(await journal.list()).toHaveLength(2);
  expect(ingest.nextDueAt()).toBeDefined();
  void fake;
});
