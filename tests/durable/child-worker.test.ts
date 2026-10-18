import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ChildManifest } from '../../src/durable/child-contracts.js';
import { CHILD_CANCELLED, runNativeChild, type ChildWorkerDeps } from '../../src/durable/child-worker.js';
import { openHostStorage } from '../../src/durable/storage.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const B = 'a'.repeat(64), J = 'b'.repeat(64);

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'child-worker-'));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'root'), outside = join(base, 'outside'), jobDir = join(base, 'job');
  await mkdir(root); await mkdir(outside); await mkdir(jobDir);
  await writeFile(join(root, 'a.txt'), 'inside file'); await writeFile(join(outside, 'secret.txt'), 'SECRET_VALUE');
  return { base, root, outside, jobDir };
}
function provider(responses: unknown[]) {
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
  const seen: any[] = [];
  faux.setResponses(responses.map(r => async (...args: any[]) => { seen.push(structuredClone(args[0])); return typeof r === 'function' ? (r as any)(...args) : r; }) as never);
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel();
  let closed = 0;
  return { faux, seen, closed: () => closed, model: { provider: model.provider, modelId: model.id }, deps: { models, provider: faux.provider, model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off', close: () => { closed++; } } as unknown as NonNullable<ChildWorkerDeps['provider']> };
}
const manifest = (s: Awaited<ReturnType<typeof setup>>, p: ReturnType<typeof provider>, over: Partial<ChildManifest> = {}): ChildManifest => ({
  version: 1, batchId: B, jobId: J, launchId: 'launch-1', purpose: 'test', createdAt: Date.now(), expiresAt: Date.now() + 1e6, deadlineAt: Date.now() + 60_000,
  endCondition: 'done', task: 'Read a.txt', context: 'ctx', model: p.model, thinkingLevel: 'off', roots: [s.root], workspaceCwd: s.root,
  provider: { credentialPath: '/x', settingsPath: '/y', account: 'a' }, ...over,
});
const forever = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
const hold = () => new Promise<never>(() => {});

it('completes with only final assistant text, exposes exactly the seven tools, and confines reads', async () => {
  const s = await setup();
  const p = provider([answer(fauxToolCall('repo_read', { path: join(s.outside, 'secret.txt') }), { stopReason: 'toolUse' }), answer(fauxToolCall('repo_read', { path: 'a.txt' }), { stopReason: 'toolUse' }), answer('FINAL REPORT')]);
  const parts: string[] = [];
  const result = await runNativeChild(s.jobDir, manifest(s, p), { provider: p.deps, onPartial: async t => { parts.push(t); } });
  expect(result).toMatchObject({ status: 'completed', output: 'FINAL REPORT', batchId: B, jobId: J, launchId: 'launch-1' });
  expect(p.seen[0].messages[0].toolsAdded.map((t: { name: string }) => t.name).sort()).toEqual(['repo_image', 'repo_list', 'repo_read', 'repo_search', 'system_info', 'web_fetch', 'web_search']);
  expect(p.seen[0].messages[0].sections.instructions).toContain('read-only');
  expect(JSON.stringify(p.seen[1].messages)).not.toContain('SECRET_VALUE');
  expect(JSON.stringify(p.seen[2].messages)).toContain('inside file');
  expect(p.closed()).toBe(0); // caller-supplied provider is not closed by the worker
  expect(parts.length).toBeGreaterThan(0);
});

it('does not replay after a terminal result and reuses the same request', async () => {
  const s = await setup();
  const p1 = provider([answer('ONCE')]);
  expect((await runNativeChild(s.jobDir, manifest(s, p1), { provider: p1.deps }))?.output).toBe('ONCE');
  const p2 = provider([answer('TWICE')]);
  expect((await runNativeChild(s.jobDir, manifest(s, p2), { provider: p2.deps }))?.output).toBe('ONCE');
  expect(p2.faux.state.callCount).toBe(0);
});

it('holds the writer until Harness close and then releases it', async () => {
  const s = await setup();
  let ready = false;
  const p = provider([async () => { await expect(openHostStorage(join(s.jobDir, 'store'))).rejects.toThrow(); return answer('X'); }]);
  const result = await runNativeChild(s.jobDir, manifest(s, p), { provider: p.deps, onReady: () => { ready = true; } });
  expect(ready).toBe(true); expect(result?.status).toBe('completed');
  (await openHostStorage(join(s.jobDir, 'store'))).release();
  const busy = await openHostStorage(join(s.jobDir, 'store'));
  await expect(runNativeChild(s.jobDir, manifest(s, provider([])), { provider: provider([]).deps })).rejects.toThrow('lease');
  busy.release();
});

it('times out at the absolute deadline and does so again after restart', async () => {
  const s = await setup();
  const p = provider([(_c: unknown, o: { signal?: AbortSignal }) => forever(o?.signal)]);
  const started = Date.now();
  const result = await runNativeChild(s.jobDir, manifest(s, p, { deadlineAt: Date.now() + 300 }), { provider: p.deps });
  expect(result?.status).toBe('timed_out'); expect(Date.now() - started).toBeLessThan(5_000);
  const s2 = await setup();
  const q = provider([answer('NEVER')]);
  expect((await runNativeChild(s2.jobDir, manifest(s2, q, { deadlineAt: Date.now() - 1 }), { provider: q.deps }))?.status).toBe('timed_out');
  expect(q.faux.state.callCount).toBe(0);
  (await openHostStorage(join(s2.jobDir, 'store'))).release();
});

it('cancels through isCancelled polling', async () => {
  const s = await setup();
  const p = provider([(_c: unknown, o: { signal?: AbortSignal }) => forever(o?.signal)]);
  let flag = false; setTimeout(() => { flag = true; }, 200);
  const result = await runNativeChild(s.jobDir, manifest(s, p), { provider: p.deps, isCancelled: async () => flag });
  expect(result?.status).toBe('cancelled');
});

it('cancels from an abort signal reason', async () => {
  const s = await setup();
  const p = provider([(_c: unknown, o: { signal?: AbortSignal }) => forever(o?.signal)]);
  const controller = new AbortController(); setTimeout(() => controller.abort(CHILD_CANCELLED), 200);
  expect((await runNativeChild(s.jobDir, manifest(s, p), { provider: p.deps, signal: controller.signal }))?.status).toBe('cancelled');
});

it('closes without an outcome when interrupted and later resumes within the same deadline', async () => {
  const s = await setup();
  const controller = new AbortController();
  const m = manifest(s, provider([]));
  const p1 = provider([answer(fauxToolCall('repo_read', { path: 'a.txt' }), { stopReason: 'toolUse' }), async (_c: unknown, o: { signal?: AbortSignal }) => { controller.abort('interrupted'); return forever(o?.signal); }]);
  const first = await runNativeChild(s.jobDir, { ...m, model: p1.model }, { provider: p1.deps, signal: controller.signal });
  expect(first).toBeUndefined();
  (await openHostStorage(join(s.jobDir, 'store'))).release();
  const p2 = provider([answer('RECOVERED')]);
  const second = await runNativeChild(s.jobDir, { ...m, model: p2.model }, { provider: p2.deps });
  expect(second).toMatchObject({ status: 'completed', output: 'RECOVERED' });
});

it('rejects unsupported model selections before opening the store', async () => {
  const s = await setup();
  const p = provider([]);
  await expect(runNativeChild(s.jobDir, manifest(s, p, { model: { provider: 'nope', modelId: 'x' } }), { provider: p.deps })).rejects.toThrow('model');
  (await openHostStorage(join(s.jobDir, 'store'))).release();
});
