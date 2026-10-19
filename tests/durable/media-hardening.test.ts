import { chmod, link, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertMediaAttachments, createAlbumJournal, createMediaIngest, MediaJournalError, type MediaIngestOptions } from '../../src/durable/media-ingest.js';
import { createMediaArtifactStore } from '../../src/durable/media-artifacts.js';
import { downloadTelegramFile, isSafeTelegramFilePath, MediaTransportError, type MediaPort } from '../../src/durable/media-transport.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); } });
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'media-hard-')); roots.push(root); return root; };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const identity = { instance: 'test', principal: 'person', bot: 'bot' };
const msg = (id: number, extra: Record<string, unknown>) => ({ message_id: id, date: 1700000000, chat: { id: 10 }, media_group_id: 'g', ...extra });
const photo = (id: string) => [{ file_id: id, file_size: 16, width: 1, height: 1 }];
const okPort: MediaPort = {
  async call(_m, body) { const id = (body as { file_id: string }).file_id; return { status: 200, payload: { ok: true, result: { file_path: `photos/${id}`, file_size: 16 } } }; },
  async file() { return new Response(png); },
};
async function setup(extra: Partial<MediaIngestOptions> = {}, port: MediaPort = okPort) {
  const root = await temp();
  const store = createMediaArtifactStore({ root: join(root, 'media') });
  const journal = createAlbumJournal(join(root, 'pending'));
  let now = 0;
  const make = () => createMediaIngest({ identity, port, store, journal, now: () => now, quietMs: 1000, ...extra });
  return { root, store, journal, make, at: (n: number) => { now = n; } };
}
const alice = { id: 1, label: 'Alice' }, bob = { id: 2, label: 'Bob' };

it('journal fails closed on corrupt, linked, loose or foreign entries', async () => {
  const { root, journal, make } = await setup();
  const first = make();
  await first.receive(msg(7, { photo: photo('a') }), { updateId: 1, actor: alice });
  const dir = join(root, 'pending');
  const [file] = await readdir(dir);
  await writeFile(join(dir, file!), '{not json');
  await expect(journal.list()).rejects.toThrow(MediaJournalError);
  await expect(make().recover()).rejects.toThrow(MediaJournalError);
  await writeFile(join(dir, file!), JSON.stringify({ updateId: 1, message: { messageId: 7 } }), { mode: 0o600 });
  await expect(journal.list()).rejects.toThrow('Invalid');
  await rm(join(dir, file!));
  await writeFile(join(dir, 'stray.txt'), 'x');
  await expect(journal.list()).rejects.toThrow('unexpected');
});

it('journal rejects group-readable, hard-linked, symlinked records and a non-private directory', async () => {
  const { root, journal, make } = await setup();
  await make().receive(msg(7, { photo: photo('a') }), { updateId: 1 });
  const dir = join(root, 'pending');
  const [file] = await readdir(dir);
  await chmod(join(dir, file!), 0o644);
  await expect(journal.list()).rejects.toThrow('private regular');
  await chmod(join(dir, file!), 0o600);
  await link(join(dir, file!), join(root, 'alias'));
  await expect(journal.list()).rejects.toThrow('private regular');
  await rm(join(root, 'alias'));
  expect(await journal.list()).toHaveLength(1);
  await chmod(dir, 0o755);
  await expect(journal.list()).rejects.toThrow('not private');
  await chmod(dir, 0o700);
  await rm(join(dir, file!));
  await symlink('/etc/hosts', join(dir, 'aaaaaaaaaaaaaaaaaaaaaaaa-1.json'));
  await expect(journal.list()).rejects.toThrow(MediaJournalError);
});

it('recover refuses unauthorized chat or actor and mixed journal actors', async () => {
  const { journal, make } = await setup();
  const w = make();
  await w.receive(msg(7, { photo: photo('a') }), { updateId: 1, actor: alice });
  await expect(make().recover()).resolves.toBeDefined();
  await expect(createMediaIngest({ identity, port: okPort, store: createMediaArtifactStore({ root: '/nonexistent-x' }), journal, authorize: r => r.actor?.id === 2 }).recover()).rejects.toThrow('not authorized');
  await journal.put({ updateId: 2, message: { messageId: 8, date: 1, chatId: 10, mediaGroupId: 'g', text: '', files: [] }, actor: bob });
  await expect(make().recover()).rejects.toThrow('ambiguous');
});

it('refuses an album with mixed senders and later members', async () => {
  const { journal, make, at } = await setup();
  const ingest = make();
  expect(await ingest.receive(msg(7, { photo: photo('a') }), { updateId: 1, actor: alice })).toMatchObject({ type: 'pending' });
  expect(await ingest.receive(msg(8, { photo: photo('b') }), { updateId: 2, actor: bob })).toMatchObject({ type: 'rejected', messageIds: [7, 8] });
  expect(await journal.list()).toHaveLength(0);
  expect(await ingest.receive(msg(9, { photo: photo('c') }), { updateId: 3, actor: alice })).toMatchObject({ type: 'rejected' });
  at(60_000);
  expect(await ingest.collect()).toEqual({ inputs: [], rejected: [], failed: [] });
});

it('treats an identical replay as idempotent and a conflicting one as a refusal', async () => {
  const { journal, make, at } = await setup();
  const ingest = make();
  await ingest.receive(msg(7, { photo: photo('a') }), { updateId: 1, actor: alice });
  expect(await ingest.receive(msg(7, { photo: photo('a') }), { updateId: 1, actor: alice })).toMatchObject({ type: 'pending' });
  expect(await journal.list()).toHaveLength(1);
  // A restart replays the journaled record; it must still match the live update.
  const again = make();
  await again.recover();
  expect(await again.receive(msg(7, { photo: photo('a') }), { updateId: 1, actor: alice })).toMatchObject({ type: 'pending' });
  expect(await again.receive(msg(7, { photo: photo('zzz') }), { updateId: 5, actor: alice })).toMatchObject({ type: 'rejected', messageIds: [7] });
  expect(await journal.list()).toHaveLength(0);
  at(5000);
  expect((await again.collect()).inputs).toEqual([]);
});

it('keeps the actor on every member and the album actor on the envelope', async () => {
  const { make, at } = await setup();
  const ingest = make();
  await ingest.receive(msg(7, { photo: photo('a') }), { updateId: 1, actor: alice });
  await ingest.receive(msg(8, { photo: photo('b') }), { updateId: 2, actor: alice });
  at(5000);
  const due = await ingest.collect();
  expect(due.inputs[0]!.envelope.actor).toEqual(alice);
});

it('requeues a collected album whose acceptance failed, and removes it only on done', async () => {
  const { journal, make, at } = await setup();
  const ingest = make();
  await ingest.receive(msg(7, { photo: photo('a') }), { updateId: 1 });
  await ingest.receive(msg(8, { photo: photo('b') }), { updateId: 2 });
  at(5000);
  const first = await ingest.collect();
  expect(first.inputs).toHaveLength(1);
  expect(ingest.nextDueAt()).toBeUndefined();
  ingest.requeue([7, 8]); // the caller could not accept it
  expect(ingest.nextDueAt()).toBeDefined();
  expect(await journal.list()).toHaveLength(2);
  at(9000);
  const second = await ingest.collect();
  expect(second.inputs).toHaveLength(1);
  expect(second.inputs[0]!.envelope.attachments).toEqual(first.inputs[0]!.envelope.attachments);
  await ingest.done([7, 8]);
  expect(await journal.list()).toHaveLength(0);
});

it('artifact verifiedPath hashes non-image files without the caller opening them', async () => {
  const root = await temp();
  const store = createMediaArtifactStore({ root: join(root, 'media') });
  const ref = await store.stage('s1', 0, { kind: 'document', name: 'a.txt', image: false }, { bytes: Buffer.from('hello') });
  const { path } = await store.verifiedPath(ref);
  await chmod(path, 0o600);
  await writeFile(path, 'HELLO'); // same size, other bytes
  await chmod(path, 0o400);
  await expect(store.verifiedPath(ref)).rejects.toMatchObject({ code: 'corrupt' });
});

it('artifact paths refuse hard links, symlinked source directories and foreign group access', async () => {
  const root = await temp();
  const store = createMediaArtifactStore({ root: join(root, 'media') });
  const ref = await store.stage('s1', 0, { kind: 'document', name: 'a.txt', image: false }, { bytes: Buffer.from('hello') });
  const { path } = await store.verifiedPath(ref);
  await link(path, join(root, 'twin'));
  await expect(store.verifiedPath(ref)).rejects.toMatchObject({ code: 'corrupt' });
  await rm(join(root, 'twin'));
  const dir = join(path, '..');
  await chmod(dir, 0o755);
  await expect(store.verifiedPath(ref)).rejects.toMatchObject({ code: 'corrupt' });
  await chmod(dir, 0o700);
  expect((await store.verifiedPath(ref)).path).toBe(path);
  // Replace the source directory with a link to a copy: ancestry escape.
  const outside = join(root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, `0-${ref.sha256}`), 'hello', { mode: 0o400 });
  await rm(dir, { recursive: true });
  await symlink(outside, dir);
  await expect(store.verifiedPath(ref)).rejects.toMatchObject({ code: 'corrupt' });
  await expect(store.stage('s1', 1, { kind: 'document', name: 'b', image: false }, { bytes: Buffer.from('x') })).rejects.toBeDefined();
});

it('sweep keeps live and retained history artifacts and never follows links', async () => {
  const root = await temp();
  let now = 1_000_000;
  const store = createMediaArtifactStore({ root: join(root, 'media'), now: () => now });
  const keep = await store.stage('retained', 0, { kind: 'document', name: 'a', image: false }, { bytes: Buffer.from('1') });
  await store.stage('old', 0, { kind: 'document', name: 'a', image: false }, { bytes: Buffer.from('2') });
  const target = join(root, 'target'); await mkdir(target); await writeFile(join(target, 'f'), 'x');
  await symlink(target, join(root, 'media', 'linked'));
  const past = new Date(0);
  for (const name of await readdir(join(root, 'media'))) await utimes(join(root, 'media', name), past, past).catch(() => undefined);
  expect(await store.sweep([], 1000, ['retained'])).toEqual({ removed: 1 });
  await expect(store.verifiedPath(keep)).resolves.toBeDefined();
  expect(await readdir(target)).toEqual(['f']);
  now += 0;
});

const portWith = (over: Partial<MediaPort>): MediaPort => ({ ...okPort, ...over });

it('download enforces a whole-transfer deadline even when the port ignores the signal', async () => {
  const hang = new Promise<never>(() => undefined);
  await expect(downloadTelegramFile(portWith({ file: () => hang }), 'a', 100, undefined, 30)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('timed out') });
  await expect(downloadTelegramFile(portWith({ call: () => hang }), 'a', 100, undefined, 30)).rejects.toMatchObject({ retryable: true });
  const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); } });
  await expect(downloadTelegramFile(portWith({ file: async () => new Response(stalled) }), 'a', 100, undefined, 30)).rejects.toMatchObject({ retryable: true });
  const ctl = new AbortController(); ctl.abort();
  await expect(downloadTelegramFile(okPort, 'a', 100, ctl.signal)).rejects.toBeInstanceOf(MediaTransportError);
});

it('download bounds streamed size and rejects unsafe file paths', async () => {
  const lying = portWith({ file: async () => new Response(new Uint8Array(50)) });
  await expect(downloadTelegramFile(lying, 'a', 10)).rejects.toMatchObject({ retryable: false });
  for (const bad of ['../x', 'a/../b', '/abs', 'a//b', './a', 'a/./b', 'a/', 'a%2e%2e/b', 'a?x=1', '.hidden/x', 'a b', '']) expect(isSafeTelegramFilePath(bad), bad).toBe(false);
  expect(isSafeTelegramFilePath('photos/file_12.jpg')).toBe(true);
  for (const bad of ['a/../b', '//evil/x']) {
    const port = portWith({ call: async () => ({ status: 200, payload: { ok: true, result: { file_path: bad } } }) });
    await expect(downloadTelegramFile(port, 'a', 100)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('invalid file path') });
  }
});

it('assertMediaAttachments still verifies after hardening', async () => {
  const { store, make } = await setup();
  const result = await make().receive({ message_id: 5, date: 1, chat: { id: 10 }, photo: photo('p') }, { updateId: 1 });
  if (result.type !== 'input') throw new Error('expected input');
  await expect(assertMediaAttachments(result.envelope, store)).resolves.toHaveLength(1);
});
