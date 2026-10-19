import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeSearch } from '../../src/durable/search.js';
import { createDomainRecallServices, type MemoryScope } from '../../src/durable/recall.js';
import { createMarkdownMemoryStore } from '../../.pi/skills/personal-memory/scripts/store.mjs';
import { appendMemoryRead } from '../../src/memory-usage.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const CREATED = new Date('2026-01-01T00:00:00.000Z');
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const vector = () => { const v = new Array<number>(1536).fill(0); v[0] = 1; return v; };

async function fixture(options: { memoryView?: MemoryScope['memoryView']; embedder?: (inputs: string[]) => Promise<number[][]>; now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'recall-integration-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vaultRoot = join(root, 'vault');
  const store = createMarkdownMemoryStore({ root: vaultRoot, now: () => CREATED });
  const search = createNativeSearch({
    stateDir: root, instanceId: 'inst', principalId: 'isaac', memoryView: 'owner-and-household',
    vaultRoot, resourceRoot: process.cwd(), stores: () => [],
  });
  cleanup.push(() => search.close());
  let refreshes = 0;
  const access = { open: () => search.memoryIndexAccess.open(), refreshMemory: () => { refreshes += 1; return search.memoryIndexAccess.refreshMemory(); } };
  const recall = createDomainRecallServices({
    index: access,
    embedder: options.embedder ? () => options.embedder! : () => undefined,
    now: options.now ?? (() => NOW),
  });
  const scope = (memoryView: MemoryScope['memoryView'] = options.memoryView ?? 'owner-and-household'): MemoryScope => ({
    principalId: 'isaac', memoryView, env: {}, stateDir: root, vaultRoot, resourceRoot: process.cwd(),
    rootConversationId: 1 as never, timeZone: 'America/New_York',
  });
  return { root, store, recall, scope, refreshes: () => refreshes };
}

it('applies the shared memory view and sees vault changes through the real index', async () => {
  const f = await fixture();
  const personal = await f.store.add({ type: 'reference', title: 'Private', body: 'kiwi personal fact', scope: 'personal', owner: 'isaac' });
  const household = await f.store.add({ type: 'reference', title: 'Shared', body: 'kiwi household fact', scope: 'household' });
  const ids = async (view: MemoryScope['memoryView']) => (await f.recall.retrieve(f.scope(view), ['kiwi'])).map(c => c.id).sort();
  expect(await ids('owner-and-household')).toEqual([personal.id, household.id].sort());
  expect(await ids('household')).toEqual([household.id]);
  expect(await ids('none')).toEqual([]);
  // Freshness: a note added after the index was built is visible on the next call.
  const added = await f.store.add({ type: 'reference', title: 'Later', body: 'kiwi later fact', scope: 'household' });
  expect(await ids('household')).toContain(added.id);
  const revisions = await f.recall.currentRevisions(f.scope('household'));
  expect([...revisions.keys()].sort()).toEqual([household.id, added.id].sort());
  expect(f.refreshes()).toBeGreaterThanOrEqual(5);
});

it('ranks fading notes down from usage logs and restores them after recall or read events', async () => {
  const f = await fixture();
  const fading = await f.store.add({ type: 'list', title: 'Kiwi list', body: 'kiwi fading list', scope: 'household' });
  const durable = await f.store.add({ type: 'reference', title: 'Kiwi ref', body: 'kiwi durable reference', scope: 'household' });
  const drops = async () => Object.fromEntries((await f.recall.retrieve(f.scope(), ['kiwi'])).map(c => [c.id, (c as { drop?: number }).drop]));
  expect(await drops()).toEqual({ [fading.id]: 2, [durable.id]: 0 });
  const at = new Date(NOW - 1000).toISOString();
  await appendFile(join(f.root, 'memory-recall.jsonl'), `${JSON.stringify({ at, candidates: [{ id: fading.id, result: 'injected' }] })}\n`);
  expect((await drops())[fading.id]).toBe(1);
  await appendMemoryRead(f.root, fading.id, new Date(NOW - 1000));
  expect((await drops())[fading.id]).toBe(0);
});

it('uses an injected embedder and drops a note archived while embedding', async () => {
  let removeDuringEmbedding: (() => Promise<unknown>) | undefined;
  const f = await fixture({ embedder: async inputs => { await removeDuringEmbedding?.(); return inputs.map(vector); } });
  const keep = await f.store.add({ type: 'reference', title: 'Keep', body: 'kiwi keep fact', scope: 'household' });
  const gone = await f.store.add({ type: 'reference', title: 'Gone', body: 'kiwi gone fact', scope: 'household' });
  expect((await f.recall.retrieve(f.scope(), ['kiwi'])).map(c => c.id).sort()).toEqual([keep.id, gone.id].sort());
  const before = f.refreshes();
  // The note leaves the active view after the first refresh, while the embedder runs.
  removeDuringEmbedding = async () => { removeDuringEmbedding = undefined; await f.store.update({ id: gone.id, ifRevision: gone.revision, patch: { status: 'archived' } }); };
  const extra = await f.store.add({ type: 'reference', title: 'Extra', body: 'kiwi extra fact', scope: 'household' });
  const after = (await f.recall.retrieve(f.scope(), ['kiwi'])).map(c => c.id);
  // Two refreshes bracket the embedding call, so the post-embedding index reflects the change.
  expect(f.refreshes() - before).toBe(2);
  expect(after).toContain(extra.id);
  expect(after).not.toContain(gone.id);
});

it('fails closed when the post-embedding refresh is incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recall-integration-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const vaultRoot = join(root, 'vault');
  const store = createMarkdownMemoryStore({ root: vaultRoot, now: () => CREATED });
  await store.add({ type: 'reference', title: 'Shared', body: 'kiwi household fact', scope: 'household' });
  const search = createNativeSearch({ stateDir: root, instanceId: 'inst', principalId: 'isaac', memoryView: 'owner-and-household', vaultRoot, resourceRoot: process.cwd(), stores: () => [] });
  cleanup.push(() => search.close());
  let calls = 0;
  const recall = createDomainRecallServices({
    index: { open: () => search.memoryIndexAccess.open(), refreshMemory: async () => { calls += 1; const r = await search.memoryIndexAccess.refreshMemory(); return calls >= 2 ? { ...r, complete: false } : r; } },
    embedder: () => async inputs => inputs.map(vector),
    now: () => NOW,
  });
  const scope: MemoryScope = { principalId: 'isaac', memoryView: 'household', env: {}, stateDir: root, vaultRoot, resourceRoot: process.cwd(), rootConversationId: 1 as never, timeZone: 'UTC' };
  await expect(recall.retrieve(scope, ['kiwi'])).rejects.toMatchObject({ failure: { stage: 'post_embedding_refresh', reason: 'refresh_incomplete' } });
});
