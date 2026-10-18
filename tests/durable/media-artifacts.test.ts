import { mkdtemp, writeFile, rm, readdir, stat, chmod, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { buildNativeUserInput, createMediaArtifactStore, MediaArtifactError, parseMediaArtifactRef } from '../../src/durable/media-artifacts.js';

const roots: string[] = [];
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'media-artifacts-')); roots.push(root); return root; };
afterEach(async () => { for (const root of roots.splice(0)) { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); } });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const meta = { kind: 'photo', name: 'p.png', image: true, mimeType: 'image/png' };
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: MediaArtifactError) => error.code);

it('stores private immutable bytes and reopens them verified', async () => {
  const root = join(await temp(), 'media');
  const store = createMediaArtifactStore({ root });
  const ref = await store.stage('src:1', 0, meta, { bytes: png });
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  const { path } = await store.verifiedPath(ref);
  expect((await stat(path)).mode & 0o777).toBe(0o400);
  expect((await store.open(JSON.parse(JSON.stringify(ref)))).bytes.equals(png)).toBe(true);
  expect(await store.stage('src:1', 0, meta, { bytes: png })).toEqual(ref);
  expect(await code(store.stage('src:1', 0, meta, { bytes: Buffer.from('other') }))).toBe('corrupt');
  expect((await readdir(join(root, (await readdir(root))[0]!))).some(name => name.startsWith('.tmp'))).toBe(false);
});

it('copies a downloaded temp file and rejects links and oversized input', async () => {
  const root = await temp();
  const store = createMediaArtifactStore({ root: join(root, 'media'), limits: { maxFileBytes: 32 } });
  await writeFile(join(root, 'in.bin'), png);
  const ref = await store.stage('s', 0, meta, { path: join(root, 'in.bin') });
  await rm(join(root, 'in.bin'));
  expect((await store.open(ref)).bytes.equals(png)).toBe(true);
  await symlink(join(root, 'media'), join(root, 'link'));
  expect(await code(store.stage('s', 1, meta, { path: join(root, 'link') }))).toBe('unsafe_source');
  expect(await code(store.stage('s', 1, meta, { bytes: Buffer.alloc(33) }))).toBe('too_large');
  await writeFile(join(root, 'big'), Buffer.alloc(40));
  expect(await code(store.stage('s', 1, meta, { path: join(root, 'big') }))).toBe('too_large');
  expect(await code(store.stage('s', 99, meta, { bytes: png }))).toBe('quota');
});

it('enforces source and total quotas', async () => {
  const root = await temp();
  const store = createMediaArtifactStore({ root, limits: { maxSourceBytes: 20, maxTotalBytes: 30 } });
  await store.stage('a', 0, meta, { bytes: Buffer.alloc(16, 1) });
  expect(await code(store.stage('a', 1, meta, { bytes: Buffer.alloc(8, 2) }))).toBe('quota');
  expect(await code(store.stage('b', 0, meta, { bytes: Buffer.alloc(16, 3) }))).toBe('quota');
});

it('detects missing, tampered, forged and cross-source references', async () => {
  const root = await temp();
  const store = createMediaArtifactStore({ root });
  const ref = await store.stage('a', 0, meta, { bytes: png });
  const other = await store.stage('b', 0, meta, { bytes: Buffer.from('zzzz') });
  expect(() => parseMediaArtifactRef({ ...ref, sourceKey: 'b' })).toThrow();
  expect(() => parseMediaArtifactRef({ ...ref, extra: 1 })).toThrow();
  expect(() => parseMediaArtifactRef({ ...ref, id: other.id })).toThrow();
  expect(() => parseMediaArtifactRef({ ...ref, name: '../x', size: -1 })).toThrow();
  const { path } = await store.verifiedPath(ref);
  await chmod(path, 0o600); await writeFile(path, Buffer.alloc(png.length, 7));
  expect(await code(store.open(ref))).toBe('corrupt');
  await rm(path, { force: true });
  expect(await code(store.open(ref))).toBe('missing');
  expect((await store.open(other)).bytes.toString()).toBe('zzzz');
});

it('retires one source and sweeps only old orphans', async () => {
  const root = await temp();
  let clock = 1_000_000;
  const store = createMediaArtifactStore({ root, now: () => clock });
  const live = await store.stage('live', 0, meta, { bytes: png });
  const dead = await store.stage('dead', 0, meta, { bytes: png });
  await store.stage('gone', 0, meta, { bytes: png });
  await store.retire('gone');
  expect(await code(store.open({ ...dead, sourceKey: 'gone' } as never))).toBe('invalid_ref');
  expect((await store.sweep(['live'], 60_000)).removed).toBe(0);
  clock += 120_000;
  for (const name of await readdir(root)) await utimes(join(root, name), new Date(clock - 100_000), new Date(clock - 100_000));
  expect((await store.sweep(['live'], 60_000)).removed).toBe(1);
  await store.open(live);
  expect(await code(store.open(dead))).toBe('missing');
});

it('refuses a linked or shared artifact root without changing its permissions', async () => {
  const root = await temp(), store = createMediaArtifactStore({ root });
  const ref = await store.stage('s', 0, meta, { bytes: png });
  await chmod(root, 0o750);
  expect(await code(store.verifiedPath(ref))).toBe('corrupt');
  expect(await code(store.stage('s', 1, meta, { bytes: png }))).toBe('corrupt');
  expect((await stat(root)).mode & 0o777).toBe(0o750);
  await chmod(root, 0o700);
  const alias = join(await temp(), 'linked');await symlink(root, alias);
  const linked = createMediaArtifactStore({ root: alias });
  expect(await code(linked.verifiedPath(ref))).toBe('corrupt');
  expect(await code(linked.stage('s', 1, meta, { bytes: png }))).toBe('corrupt');
});

it('builds native input with real image content and fails whole when media is missing', async () => {
  const root = await temp();
  const store = createMediaArtifactStore({ root });
  const image = await store.stage('s', 0, meta, { bytes: png });
  const voice = await store.stage('s', 1, { kind: 'voice', name: 'v.ogg', image: false, mimeType: 'audio/ogg' }, { bytes: Buffer.from('ogg') });
  const input = await buildNativeUserInput('hello', [image, voice], store);
  expect(input).toEqual([{ type: 'text', text: 'hello' }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
  expect(await buildNativeUserInput('only text', [voice], store)).toBe('only text');
  const prepared = await buildNativeUserInput('x', [image], store, { images: { prepare: async (_bytes, mime) => ({ data: 'AAAA', mimeType: mime }) } });
  expect((prepared as { data: string }[])[1]!.data).toBe('AAAA');
  expect(await code(buildNativeUserInput('x', [image], store, { limits: { maxWidth: 1, maxHeight: 1, maxBytes: 4 } }))).toBe('too_large');
  expect(await code(buildNativeUserInput('x', [image], store, { images: { prepare: async () => undefined } }))).toBe('too_large');
  await store.retire('s');
  expect(await code(buildNativeUserInput('x', [image], store))).toBe('missing');
});
