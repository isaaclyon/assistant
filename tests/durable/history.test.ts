import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  citationFor, createHistoryResolver, decodeNativeSessionId, encodeNativeSessionId, locatorFromCitation, projectNativeEntry,
} from '../../src/durable/history.js';
import { assistant, fakeStore, iso, T0, toolResult, user } from './history-fixture.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function dir() { const d = await mkdtemp(join(tmpdir(), 'history-')); dirs.push(d); return d; }

test('native session ids round-trip and reject anything non-canonical', () => {
  const identity = { instanceId: 'inst/ä', storeId: 'main', conversationId: 7 };
  const id = encodeNativeSessionId(identity);
  expect(id).toMatch(/^[A-Za-z0-9._-]+$/u);
  expect(decodeNativeSessionId(id)).toEqual(identity);
  for (const bad of [`${id}.1`, id.replace(/\.7$/u, '.07'), id.replace(/\.7$/u, '.0'), 'durable.v1.x.y.1', 'durable.v1..main.1', '../durable.v1.a.b.1']) expect(decodeNativeSessionId(bad)).toBeUndefined();
  expect(() => encodeNativeSessionId({ ...identity, conversationId: 0 })).toThrow();
});

test('citations keep the three archived fields for both backends and never carry a path', () => {
  const locator = { backend: 'durable' as const, instanceId: 'inst', storeId: 'main', conversationId: 3, entryId: 9, timestamp: iso(T0) };
  const citation = citationFor(locator);
  expect(Object.keys(citation).sort()).toEqual(['entryId', 'sessionId', 'timestamp']);
  expect(citation.entryId).toBe('9');
  expect(locatorFromCitation(citation)).toEqual(locator);
  expect(locatorFromCitation({ sessionId: 'old-session', entryId: 'abcdef12', timestamp: iso(T0) })).toEqual({ backend: 'jsonl', sessionId: 'old-session', entryId: 'abcdef12', timestamp: iso(T0) });
  expect(locatorFromCitation({ sessionId: 'durable.v1.bad', entryId: '1', timestamp: iso(T0) })).toBeUndefined();
  expect(locatorFromCitation({ ...citation, entryId: '9abc' })).toBeUndefined();
});

test('projection is an allowlist: only source user input, assistant text and safe tool results', () => {
  const conv = (entry: ReturnType<typeof user>) => ({ ...entry, conversationId: 2 });
  expect(projectNativeEntry(conv(user(2, 'hello')))).toMatchObject({ role: 'user', text: 'hello', timestamp: iso(T0 + 2000) });
  // Source time wins over admission time.
  expect(projectNativeEntry(conv(user(2, 'hello', T0 - 86_400_000)))!.timestamp).toBe(iso(T0 - 86_400_000));
  expect(projectNativeEntry(conv(assistant(3, 'hi')))!.role).toBe('assistant');
  expect(projectNativeEntry(conv(toolResult(4, 'weather', 'sunny')))!.role).toBe('toolResult');
  expect(projectNativeEntry(conv(toolResult(5, 'private_browser_input', 'hunter2')))).toBeUndefined();
  for (const kind of ['pi.system', 'pi.reset', 'pi.compaction', 'bridge.control', 'pi.custom', 'unknown']) {
    expect(projectNativeEntry({ ...conv(user(6, 'secret system text')), kind })).toBeUndefined();
  }
  expect(projectNativeEntry({ ...conv(user(7, 'x')), data: { originalAt: T0, hidden: true } })).toBeUndefined();
  expect(projectNativeEntry({ ...conv(user(7, 'x')), data: { originalAt: T0, customType: 'date-context' } })).toBeUndefined();
  expect(projectNativeEntry({ ...conv(user(7, 'x')), data: { originalAt: 'not a time' } })).toBeUndefined();
  expect(projectNativeEntry({ ...conv(assistant(8, 'x')), model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }], timestamp: T0 }] })).toBeUndefined();
});

test('resolver binds reads to principal, store and current conversation visibility', async () => {
  const mine = fakeStore(); const foreign = fakeStore({ storeId: 'other', principal: 'emma' });
  mine.add(2, user(2, 'first')); mine.add(2, { id: 3, kind: 'pi.system', model: [{ role: 'system', content: 'prompt' }] }); mine.add(2, assistant(4, 'second'));
  foreign.add(5, user(5, 'foreign'));
  const history = createHistoryResolver({ principal: 'isaac', nativeStores: () => [mine, foreign] });
  const id = encodeNativeSessionId({ instanceId: 'inst', storeId: 'main', conversationId: 2 });
  expect(await history.resolveNative(id, '2', iso(T0 + 2000))).toMatchObject({ evidence: { text: 'first' } });
  expect(await history.resolveNative(id, '2', iso(T0))).toBeUndefined();
  expect(await history.resolveNative(id, '3')).toBeUndefined();
  expect(await history.resolveNative(id, '99')).toBeUndefined();
  expect(await history.resolveNative(encodeNativeSessionId({ instanceId: 'inst', storeId: 'other', conversationId: 5 }), '5')).toBeUndefined();
  // A conversation in the wrong session id is not readable through another's id.
  expect(await history.resolveNative(encodeNativeSessionId({ instanceId: 'inst', storeId: 'main', conversationId: 5 }), '5')).toBeUndefined();
  mine.visible.delete(2);
  expect(await history.resolveNative(id, '2')).toBeUndefined();
});

test('context windows skip hidden entries, stay inside one conversation and report more history', async () => {
  const store = fakeStore();
  store.add(2, user(2, 'a')); store.add(2, assistant(3, 'b')); store.add(2, { id: 4, kind: 'pi.compaction', model: [{ role: 'user', content: 'summary', timestamp: T0 }] });
  store.add(2, user(5, 'c')); store.add(2, assistant(6, 'd'));
  store.add(9, user(9, 'other conversation'));
  const history = createHistoryResolver({ principal: 'isaac', nativeStores: () => [store] });
  const id = encodeNativeSessionId({ instanceId: 'inst', storeId: 'main', conversationId: 2 });
  const window = await history.readNativeContext(id, '5', 2, 5);
  expect(window!.before.map(e => e.text)).toEqual(['a', 'b']);
  expect(window!.after.map(e => e.text)).toEqual(['d']);
  expect(window).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false });
  const narrow = await history.readNativeContext(id, '5', 1, 0);
  expect(narrow!.before.map(e => e.text)).toEqual(['b']);
  expect(narrow).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
  expect(await history.readNativeContext(id, '4', 1, 1)).toBeUndefined();
});

test('anchor findings use lint vocabulary for old and new citations', async () => {
  const root = await dir();
  const timestamp = '2026-07-19T03:30:00.000Z';
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '2026-07-19T03-30-00-000Z_session-1.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp, cwd: '/repo' }),
    JSON.stringify({ type: 'message', id: 'abcdef12', parentId: null, timestamp, message: { role: 'user', content: 'old evidence' } }),
  ].join('\n') + '\n');
  const store = fakeStore(); store.add(2, user(2, 'new evidence'));
  const history = createHistoryResolver({ principal: 'isaac', nativeStores: () => [store], legacyRoots: [root] });
  const id = encodeNativeSessionId({ instanceId: 'inst', storeId: 'main', conversationId: 2 });
  const missing = encodeNativeSessionId({ instanceId: 'inst', storeId: 'main', conversationId: 8 });
  expect(await history.resolveAnchors([
    { sessionId: 'session-1', entryId: 'abcdef12', timestamp },
    { sessionId: 'session-1', entryId: 'deadbeef', timestamp },
    { sessionId: 'session-1', entryId: 'abcdef12', timestamp: '2026-07-20T03:30:00.000Z' },
    { sessionId: 'gone', entryId: 'abcdef12', timestamp },
    { sessionId: id, entryId: '2', timestamp: iso(T0 + 2000) },
    { sessionId: id, entryId: '3', timestamp: iso(T0 + 2000) },
    { sessionId: id, entryId: '2', timestamp },
    { sessionId: missing, entryId: '2', timestamp },
    { sessionId: 'durable.v1.garbage', entryId: '2', timestamp },
  ])).toEqual([null, 'SOURCE_ENTRY_NOT_FOUND', 'SOURCE_TIMESTAMP_MISMATCH', 'SOURCE_SESSION_NOT_FOUND', null,
    'SOURCE_ENTRY_NOT_FOUND', 'SOURCE_TIMESTAMP_MISMATCH', 'SOURCE_SESSION_NOT_FOUND', 'SOURCE_SESSION_INVALID']);
});
