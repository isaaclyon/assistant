import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { NativeConfig } from '../../src/durable/config.js';
import { createMediaArtifactStore } from '../../src/durable/media-artifacts.js';
import { createAlbumJournal, createMediaIngest } from '../../src/durable/media-ingest.js';
import type { MediaPort } from '../../src/durable/media-transport.js';
import { NATIVE_PROFILE_IDS, profilePolicy } from '../../src/durable/profiles.js';
import { assertNativeEnvelope, bridgeTelegram, normalizeTelegramUpdate } from '../../src/durable/telegram-bridge.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const priv = { instanceId: 'test', principal: 'isaac', capabilityProfile: 'durable-personal-isaac', jobsRole: 'disabled', transport: { mode: 'broker', botId: 123, allowedUserId: 42, socketPath: '/tmp/x.sock' } } as NativeConfig;
const group = { instanceId: 'test', principal: 'household', capabilityProfile: 'durable-household-shared', jobsRole: 'disabled', transport: { mode: 'broker', botId: 123, allowedUserId: 42, socketPath: '/tmp/x.sock' }, group: { chatId: -50, actors: [{ id: 42, label: 'Isaac' }, { id: 43, label: 'Emma' }] } } as unknown as NativeConfig;
const photo = [{ file_id: 'p1', file_size: 16, width: 1, height: 1 }];
const msg = (id: number, over: Record<string, unknown> = {}, chat: Record<string, unknown> = { id: 42, type: 'private' }, from: Record<string, unknown> = { id: 42 }) => ({ message_id: id, date: 1700000000, from, chat, ...over });
const up = (id: number, message: Record<string, unknown>) => ({ update_id: id, message });

async function rig(config: NativeConfig, root?: string) {
  if (!root) { root = await mkdtemp(join(tmpdir(), 'bridge-media-')); roots.push(root); }
  const calls: string[] = [];
  const port: MediaPort = {
    async call(_m, body) { calls.push('call'); return { status: 200, payload: { ok: true, result: { file_path: `files/${(body as any).file_id}`, file_size: png.length } } }; },
    async file() { return new Response(png as unknown as Blob); },
  };
  const journal = createAlbumJournal(join(root, 'pending'));
  const ingest = createMediaIngest({ identity: { instance: 'test', principal: config.principal, bot: '123' }, port, store: createMediaArtifactStore({ root: join(root, 'media') }), journal, quietMs: 20,
    authorize: ({ chatId, actor }) => (config.group ? chatId === config.group.chatId && !!actor && config.group.actors.some(a => a.id === actor.id) : chatId === 42) });
  let hooks!: any;
  const raw = { start: vi.fn(async (h: any) => { hooks = h; return 'ready' as const; }), stop: vi.fn(async () => {}), deliver: vi.fn(async () => 1), answerCallback: vi.fn(async () => true) };
  const failure = vi.fn();
  const transport = bridgeTelegram(config, raw as any, failure, { media: ingest });
  return { root, calls, journal, ingest, raw, failure, transport, accept: (u: any) => hooks.accept(u), pending: async () => (await readdir(join(root, 'pending')).catch(() => [])).length };
}
const wait = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); expect(check()).toBe(true); };

test('only the four full profiles enable media', () => {
  const on = NATIVE_PROFILE_IDS.filter(id => profilePolicy(id)?.media === true).sort();
  expect(on).toEqual(['durable-builder', 'durable-household-shared', 'durable-personal-emma', 'durable-personal-isaac']);
  expect(NATIVE_PROFILE_IDS).toHaveLength(18);
});

test('private authorized photo becomes an accepted envelope with attachments', async () => {
  const r = await rig(priv); const envelopes: any[] = [];
  await r.transport.start(async e => { envelopes.push(e); }, async () => {});
  await r.accept(up(1, msg(5, { caption: 'look', photo })));
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]).toMatchObject({ chatId: 42, messageIds: [5], attachments: [expect.anything()] });
  expect(envelopes[0].actor).toBeUndefined();
  expect(() => assertNativeEnvelope(priv, envelopes[0])).not.toThrow();
  await r.transport.stop();
});

test('single input accept failure leaves the update retryable', async () => {
  const r = await rig(priv); let fail = true; const envelopes: any[] = [];
  await r.transport.start(async e => { if (fail) throw new Error('storage'); envelopes.push(e); }, async () => {});
  await expect(r.accept(up(1, msg(5, { photo })))).rejects.toThrow('storage');
  fail = false; await r.accept(up(1, msg(5, { photo })));
  expect(envelopes).toHaveLength(1);
  await r.transport.stop();
});

test('unauthorized, topic, callback and old profiles never download or journal', async () => {
  const r = await rig(priv); const input = vi.fn(async () => {});
  await r.transport.start(input, async () => {});
  await r.accept(up(1, msg(5, { photo }, { id: 42, type: 'private' }, { id: 99 })));
  await r.accept(up(2, msg(6, { photo, message_thread_id: 3 })));
  await r.accept(up(3, msg(7, { media_group_id: 'g', photo, message_thread_id: 3 })));
  expect(r.calls).toEqual([]); expect(input).not.toHaveBeenCalled(); expect(await r.pending()).toBe(0);
  expect(r.raw.deliver).toHaveBeenCalledTimes(2);
  const old = { ...priv, capabilityProfile: 'durable-chat-memory-test' } as NativeConfig;
  expect(normalizeTelegramUpdate(old, up(4, msg(8, { photo })))).toMatchObject({ type: 'rejected' });
  expect(normalizeTelegramUpdate(priv, { update_id: 5, callback_query: { id: 'c', data: 'x', from: { id: 42 }, message: msg(9, { photo }) } })).toMatchObject({ type: 'callback' });
  await r.transport.stop();
});

test('group media carries the authenticated actor; topics and other chats are refused', async () => {
  const chat = { id: -50, type: 'supergroup' };
  expect(normalizeTelegramUpdate(group, up(1, msg(5, { photo }, chat, { id: 43 })))).toMatchObject({ type: 'media', actor: { id: 43, label: 'Emma' } });
  expect(normalizeTelegramUpdate(group, up(2, msg(5, { photo }, chat, { id: 77 })))).toEqual({ type: 'ignored' });
  expect(normalizeTelegramUpdate(group, up(3, msg(5, { photo, is_topic_message: true }, chat, { id: 43 })))).toMatchObject({ type: 'rejected' });
  const r = await rig(group); const envelopes: any[] = [];
  await r.transport.start(async e => { envelopes.push(e); }, async () => {});
  await r.accept(up(4, msg(8, { photo }, chat, { id: 43 })));
  expect(envelopes[0].actor).toEqual({ id: 43, label: 'Emma' });
  expect(() => assertNativeEnvelope(group, envelopes[0])).not.toThrow();
  await r.transport.stop();
});

test('album is journaled before ack, recovered after restart, and accepted by the timer', async () => {
  const r = await rig(priv); const envelopes: any[] = [];
  await r.transport.start(async e => { envelopes.push(e); }, async () => {});
  await r.accept(up(1, msg(10, { media_group_id: 'g', photo, caption: 'a' })));
  expect(await r.pending()).toBe(1); expect(envelopes).toHaveLength(0);
  await r.transport.stop();
  const r2 = await rig(priv, r.root); const seen: any[] = [];
  await r2.transport.start(async e => { seen.push(e); }, async () => {});
  await wait(() => seen.length === 1);
  expect(seen[0].messageIds).toEqual([10]);
  await r2.transport.stop();
  expect(await r2.pending()).toBe(0);
});

test('durable accept failure requeues the album and loses nothing', async () => {
  const r = await rig(priv); const envelopes: any[] = []; let fails = 2;
  await r.transport.start(async e => { if (fails-- > 0) throw new Error('db down'); envelopes.push(e); }, async () => {});
  await r.accept(up(1, msg(10, { media_group_id: 'g', photo })));
  await r.accept(up(2, msg(11, { media_group_id: 'g', photo })));
  await wait(() => envelopes.length === 1);
  expect(envelopes[0].messageIds).toEqual([10, 11]);
  expect(r.failure).toHaveBeenCalledTimes(2);
  await r.transport.stop(); expect(await r.pending()).toBe(0);
});

test('recovery fails closed before the transport starts', async () => {
  const r = await rig(priv);
  await r.transport.start(async () => {}, async () => {});
  await r.accept(up(1, msg(10, { media_group_id: 'g', photo }))); await r.transport.stop();
  const other = await rig({ ...priv, transport: { ...priv.transport } } as NativeConfig, r.root);
  const strict = createMediaIngest({ identity: { instance: 'test', principal: 'isaac', bot: '123' }, port: {} as MediaPort, store: createMediaArtifactStore({ root: join(r.root, 'media') }), journal: createAlbumJournal(join(r.root, 'pending')), authorize: () => false });
  const raw = { start: vi.fn(async () => 'ready' as const), stop: async () => {}, deliver: async () => 1, answerCallback: async () => true };
  await expect(bridgeTelegram(priv, raw as any, vi.fn(), { media: strict }).start(async () => {}, async () => {})).rejects.toThrow();
  expect(raw.start).not.toHaveBeenCalled(); void other;
});

test('attachments are allowed only for media-enabled human envelopes', () => {
  const base = { instance: 'test', principal: 'isaac', bot: '123', chatId: 42, messageIds: [1], originalAt: 1, content: 'x', attachments: [{ id: 'a' }] } as any;
  expect(() => assertNativeEnvelope(priv, base)).not.toThrow();
  expect(() => assertNativeEnvelope({ ...priv, capabilityProfile: 'durable-chat-memory-test' } as NativeConfig, base)).toThrow(/authority/);
  expect(() => assertNativeEnvelope(priv, { ...base, proactive: true, messageIds: [], job: 'j' })).toThrow(/authority/);
  expect(() => assertNativeEnvelope(priv, { ...base, attachments: ['str'] })).toThrow(/authority/);
});
