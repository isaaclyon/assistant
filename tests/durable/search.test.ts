import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createNativeSearch, createSearchBundle, type NativeSearchOptions } from '../../src/durable/search.js';
import { encodeNativeSessionId } from '../../src/durable/history.js';
import { lintMemoryVault } from '../../.pi/skills/personal-memory/scripts/inspect.mjs';
import { createMarkdownMemoryStore } from '../../.pi/skills/personal-memory/scripts/store.mjs';
import { assistant, fakeStore, iso, T0, toolResult, user, type FakeStore } from './history-fixture.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dir() { const d = await mkdtemp(join(tmpdir(), 'search-')); dirs.push(d); return d; }
async function service(overrides: Partial<NativeSearchOptions> & { stores: () => readonly FakeStore[] }, state?: string) {
  const root = state ?? await dir();
  const search = createNativeSearch({
    stateDir: root, instanceId: 'inst', principalId: 'isaac', memoryView: 'owner-and-household',
    vaultRoot: join(root, 'vault'), resourceRoot: process.cwd(), ...overrides,
  });
  closers.push(() => search.close());
  return { search, root };
}
type Result = { sessionId: string; entryId: string; role: string; timestamp: string; backend: string; sourcePath?: string; sourceOffset?: number; snippet: string; locator?: unknown };
const results = (envelope: { ok: boolean; result: unknown; error: unknown }) => { expect(envelope.ok).toBe(true); return (envelope.result as { results: Result[] }).results; };
const sessionId = (conversationId: number, storeId = 'main') => encodeNativeSessionId({ instanceId: 'inst', storeId, conversationId });

test('indexes only visible evidence and returns anchors without paths', async () => {
  const store = fakeStore();
  store.add(2, user(2, 'We discussed the zebra migration plan'));
  store.add(2, assistant(3, 'The zebra plan needs two steps'));
  store.add(2, { id: 4, kind: 'pi.system', model: [{ role: 'system', content: 'zebra hidden system prompt' }] });
  store.add(2, { ...user(5, 'zebra recalled context'), data: { originalAt: T0, customType: 'recall' } });
  store.add(2, toolResult(6, 'private_browser_login', 'zebra password hunter2'));
  store.add(2, toolResult(7, 'weather', 'zebra forecast sunny'));
  const { search } = await service({ stores: () => [store] });
  const found = results(await search.sessionSearch({ query: 'zebra' }));
  expect(found.map(r => r.entryId).sort()).toEqual(['2', '3']);
  for (const r of found) {
    expect(r.backend).toBe('durable');
    expect(r.sessionId).toBe(sessionId(2));
    expect(r).not.toHaveProperty('sourcePath');
    expect(r).not.toHaveProperty('sourceOffset');
  }
  expect(found.find(r => r.entryId === '2')!.timestamp).toBe(iso(T0 + 2000));
  expect(JSON.stringify(found)).not.toContain('hunter2');
  expect(results(await search.sessionSearch({ query: 'zebra', roles: ['toolResult'] })).map(r => r.entryId)).toEqual(['7']);
  expect(results(await search.sessionSearch({ query: 'hunter2', roles: ['user', 'assistant', 'toolResult'] }))).toEqual([]);
  expect(results(await search.sessionSearch({ query: 'zebra', from: iso(T0 + 3000) }))).toHaveLength(1);
  expect(results(await search.sessionSearch({ query: 'zebra', project: 'repo' }))).toEqual([]);
});

test('refresh is incremental, survives restart, and rebuilds when the store changes underneath', async () => {
  const store = fakeStore();
  store.add(2, user(2, 'alpha one'));
  const state = await dir();
  let { search } = await service({ stores: () => [store] }, state);
  expect(results(await search.sessionSearch({ query: 'alpha' }))).toHaveLength(1);
  store.add(2, assistant(3, 'alpha two'));
  expect(results(await search.sessionSearch({ query: 'alpha' }))).toHaveLength(2);
  await search.close();
  ({ search } = await service({ stores: () => [store] }, state));
  const status = await search.refreshSessions();
  expect(status).toMatchObject({ complete: true, native: [{ indexed: 0, rebuilt: 0, appended: 0 }] });
  // The same ids with different content are not trusted; a replaced store rebuilds.
  store.entries.set(2, [{ ...assistant(2, 'beta restored'), conversationId: 2 }, { ...assistant(3, 'beta again'), kind: 'pi.assistant', conversationId: 2 }]);
  const after = await search.refreshSessions();
  expect(after).toMatchObject({ complete: true, native: [{ rebuilt: 1 }] });
  expect(results(await search.sessionSearch({ query: 'alpha' }))).toEqual([]);
  expect(results(await search.sessionSearch({ query: 'beta' }))).toHaveLength(2);
  // Explicit rebuild reproduces the same corpus.
  expect(results(await (async () => { await search.indexOperation({ operation: 'rebuild', corpus: 'session' }); return search.sessionSearch({ query: 'beta' }); })())).toHaveLength(2);
});

test('conversations that leave the principal view disappear from search and context', async () => {
  const store = fakeStore();
  store.add(2, user(2, 'gamma secret'));
  store.add(3, user(3, 'gamma other'));
  const { search } = await service({ stores: () => [store] });
  expect(results(await search.sessionSearch({ query: 'gamma' }))).toHaveLength(2);
  store.visible.delete(2);
  expect(results(await search.sessionSearch({ query: 'gamma' })).map(r => r.entryId)).toEqual(['3']);
  const context = await search.sessionContext({ sessionId: sessionId(2), entryId: '2' });
  expect(context.ok).toBe(false);
});

test('other principals, stores and instances stay out of results', async () => {
  const mine = fakeStore(); const emma = fakeStore({ storeId: 'emma', principal: 'emma' }); const stranger = fakeStore({ instanceId: 'other' });
  mine.add(2, user(2, 'delta mine')); emma.add(4, user(4, 'delta emma')); stranger.add(6, user(6, 'delta stranger'));
  const { search } = await service({ stores: () => [mine, emma, stranger] });
  expect(results(await search.sessionSearch({ query: 'delta' })).map(r => r.snippet)).toEqual([expect.stringContaining('mine')]);
  expect((await search.sessionContext({ sessionId: sessionId(4, 'emma'), entryId: '4' })).ok).toBe(false);
});

test('context reads a bounded native window with citations and budgets text', async () => {
  const store = fakeStore();
  store.add(2, user(2, 'one')); store.add(2, assistant(3, 'lorem ipsum '.repeat(500))); store.add(2, user(4, 'three'));
  store.add(2, { id: 5, kind: 'pi.compaction', model: [{ role: 'user', content: 'summary', timestamp: T0 }] });
  store.add(2, assistant(6, 'four'));
  const { search } = await service({ stores: () => [store] });
  const ok = await search.sessionContext({ sessionId: sessionId(2), entryId: '4', before: 1, after: 1 });
  const value = ok.result as { entries: Array<{ entryId: string; isTarget: boolean; text: string; truncated: boolean; locator: unknown }>; hasMoreBefore: boolean; hasMoreAfter: boolean; truncated: boolean };
  expect(value.entries.map(e => [e.entryId, e.isTarget])).toEqual([['3', false], ['4', true], ['6', false]]);
  expect(value.entries[0]!.text.length).toBeLessThanOrEqual(1200);
  expect(value.truncated).toBe(true);
  expect(value.hasMoreBefore).toBe(true);
  expect(value.hasMoreAfter).toBe(false);
  expect(JSON.stringify(value)).not.toContain('summary');
  for (const bad of [{ entryId: '5' }, { entryId: '0' }, { entryId: '4abc' }, { entryId: '4', before: 6 }, { entryId: '4', maxChars: 10 }, { sessionId: 'durable.v1.nope' }]) {
    const failed = await search.sessionContext({ sessionId: sessionId(2), entryId: '4', ...bad });
    expect(failed.ok).toBe(false);
  }
});

test('archived JSONL evidence and native evidence merge in one search', async () => {
  const legacy = await dir();
  const timestamp = '2026-07-19T03:30:00.000Z';
  await writeFile(join(legacy, '2026-07-19T03-30-00-000Z_session-1.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp, cwd: '/repo' }),
    JSON.stringify({ type: 'message', id: 'abcdef12', parentId: null, timestamp, message: { role: 'user', content: 'epsilon archived' } }),
  ].join('\n') + '\n');
  const store = fakeStore(); store.add(2, user(2, 'epsilon native'));
  const { search } = await service({ stores: () => [store], legacySessionRoots: [legacy] });
  const found = results(await search.sessionSearch({ query: 'epsilon' }));
  expect(found.map(r => r.backend).sort()).toEqual(['durable', 'jsonl']);
  expect(found.find(r => r.backend === 'jsonl')!.sourcePath).toContain('session-1.jsonl');
  expect(found.find(r => r.backend === 'durable')).not.toHaveProperty('sourcePath');
  expect(results(await search.sessionSearch({ query: 'epsilon', limit: 1 }))).toHaveLength(1);
  const archived = await search.sessionContext({ sessionId: 'session-1', entryId: 'abcdef12' });
  expect(archived.ok).toBe(true);
  expect(results(await search.sessionSearch({ query: 'epsilon', project: 'repo' })).map(r => r.backend)).toEqual(['jsonl']);
});

test('invalid input returns a typed error and no index work', async () => {
  const { search } = await service({ stores: () => [] });
  expect(await search.sessionSearch({ query: '' })).toMatchObject({ ok: false, error: { code: expect.any(String) } });
  expect(await search.sessionSearch({ query: 'x', limit: 0 })).toMatchObject({ ok: false });
  expect(await search.sessionSearch({ query: 'x', from: 'yesterday' })).toMatchObject({ ok: false });
  expect(await search.sessionSearch({ query: 'x', roles: ['system'] })).toMatchObject({ ok: false });
});

test('index operation reports status and per-store counts', async () => {
  const store = fakeStore(); store.add(2, user(2, 'zeta'));
  const { search } = await service({ stores: () => [store] });
  const refreshed = await search.indexOperation({ operation: 'refresh', corpus: 'session' });
  expect(refreshed).toMatchObject({ ok: true, result: { session: { complete: true, native: [{ storeId: 'main', indexed: 1 }] } } });
  const status = await search.indexOperation({ operation: 'status' });
  expect(status.ok).toBe(true);
});

test('memory lint accepts native and archived citations through the provenance hook', async () => {
  const base = await dir(); const legacy = join(base, 'sessions'); await mkdir(legacy);
  const timestamp = '2026-07-19T03:30:00.000Z';
  await writeFile(join(legacy, '2026-07-19T03-30-00-000Z_session-1.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp, cwd: '/repo' }),
    JSON.stringify({ type: 'message', id: 'abcdef12', parentId: null, timestamp, message: { role: 'user', content: 'old' } }),
  ].join('\n') + '\n');
  const store = fakeStore(); store.add(2, user(2, 'new'));
  const { search } = await service({ stores: () => [store], legacySessionRoots: [legacy] }, base);
  const root = join(base, 'vault');
  const notes = createMarkdownMemoryStore({ root, now: () => new Date(timestamp) });
  const native = sessionId(2);
  await notes.add({ type: 'reference', title: 'Cited', body: [
    'Old and new.[^source-old][^source-new]', '',
    `[^source-old]: Pi session \`session-1\`, entry \`abcdef12\`, \`${timestamp}\`.`,
    `[^source-new]: Pi session \`${native}\`, entry \`2\`, \`${iso(T0 + 2000)}\`.`].join('\n') });
  const good = await lintMemoryVault({ root, sourceResolver: search.provenanceResolver }) as { valid: boolean };
  expect(good.valid).toBe(true);
  store.visible.delete(2);
  const bad = await lintMemoryVault({ root, sourceResolver: search.provenanceResolver }) as { valid: boolean; errors: Array<{ code: string }> };
  expect(bad.valid).toBe(false);
  expect(bad.errors.map(e => e.code)).toEqual(['SOURCE_SESSION_NOT_FOUND']);
  // Without a resolver or roots, the legacy loader still refuses native ids.
  const legacyOnly = await lintMemoryVault({ root, sessionRoots: [legacy] }) as { errors: Array<{ code: string }> };
  expect(legacyOnly.errors.map(e => e.code)).toEqual(['SOURCE_SESSION_NOT_FOUND']);
});

test('memory search honors the household view and the bundle exposes the four tools', async () => {
  const base = await dir(); const root = join(base, 'vault');
  const notes = createMarkdownMemoryStore({ root, now: () => new Date('2026-07-19T03:30:00.000Z') });
  await notes.add({ type: 'reference', title: 'Private', body: 'kiwi personal fact', scope: 'personal', owner: 'isaac' });
  const household = await notes.add({ type: 'reference', title: 'Shared', body: 'kiwi household fact', scope: 'household' });
  const make = (principalId: string, memoryView: NativeSearchOptions['memoryView']) => service({ stores: () => [], principalId, memoryView, vaultRoot: root }, join(base, `state-${principalId}`));
  const owner = (await make('isaac', 'owner-and-household')).search;
  const house = (await make('household', 'household')).search;
  const builder = (await make('engineering', 'none')).search;
  const ids = async (s: typeof owner) => ((await s.memorySearch({ query: 'kiwi' })).result as { results: Array<{ id: string }> }).results.map(r => r.id);
  expect((await ids(owner)).length).toBe(2);
  expect(await ids(house)).toEqual([household.id]);
  expect(await ids(builder)).toEqual([]);
  const bundle = createSearchBundle(owner);
  expect(bundle.tools.map(t => t.tool.name).sort()).toEqual(['assistant_memory_search', 'assistant_session_search', 'search_index', 'session_context']);
  expect(bundle.tools.every(t => t.tool.replay === 'safe')).toBe(true);
});
