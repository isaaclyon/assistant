import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { DurableHost, type HostConfig } from '../../src/durable/host.js';
import { Bindings, context, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { createContextBundle, ContextLedger, type ContextBundleOptions } from '../../src/durable/context.js';
import type { MemoryScope, RecallServices } from '../../src/durable/recall.js';
import type { SemanticJudge } from '../../src/semantic-judge.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'durable-context-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; }
// 2023-11-14 22:13:20 UTC; Tuesday.
const BASE = 1700000000000;
const envelope = (id = 1, content = `input ${id}`, originalAt = BASE + id): SourceEnvelope => ({ instance: 'test', principal: 'person', bot: 'bot', chatId: 10, threadId: 2, messageIds: [id], originalAt, content });

const candidate = (id: string, snippet = `note ${id}`) => ({ id, revision: 'r1', title: id, type: 'preference', snippet });

async function setup(path: string, opts: {
  env?: Record<string, string>; memoryView?: MemoryScope['memoryView']; recall?: RecallServices | null; judge?: ContextBundleOptions['judge'];
  responses?: unknown[]; onError?: (stage: string, e: unknown) => void; scoped?: boolean; extra?: Partial<HostConfig>;
} = {}) {
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
  const seen: Array<readonly any[]> = [];
  const responses = (opts.responses ?? [answer('ONE'), answer('TWO'), answer('THREE')]).map(r => (request: any) => { seen.push(request.messages); return r as never; });
  faux.setResponses(responses as never);
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel();
  let hostRef: DurableHost | undefined;
  const logs: unknown[] = [];
  const bundle = createContextBundle({
    async scope() {
      if (opts.scoped === false) return undefined;
      return { principalId: 'isaac', memoryView: opts.memoryView ?? 'owner-and-household', env: opts.env ?? {}, stateDir: path, vaultRoot: join(path, 'vault'), resourceRoot: path, rootConversationId: hostRef!.runtime.root.id, timeZone: 'America/New_York' };
    },
    harness: () => hostRef!.runtime.harness,
    ...(opts.recall === null ? {} : { recall: opts.recall ?? { retrieve: async () => [], currentRevisions: async () => new Map() } }),
    ...(opts.judge ? { judge: opts.judge } : {}),
    log: async (_s, r) => { logs.push(r); if (process.env.C3_DEBUG) console.log('LOG', JSON.stringify(r)); },
    onError: opts.onError ?? ((s, e) => { if (process.env.C3_DEBUG) console.log('ERR', s, e); }),
  });
  const registry = createRegistry();
  const memoryExt = defineExtension({ name: 'core-memory', hooks: bundle.contributions!.hooks });
  registry.install(memoryExt);
  const tool = defineTool({ name: 'ping', description: 'fixture', parameters: Type.Object({}), replay: 'safe', execute: async () => ({ output: [{ type: 'text', text: 'pong' }] }) });
  const pingExt = defineExtension({ name: 'ping', tools: [tool] });
  registry.install(pingExt);
  const h = await DurableHost.create({
    stateDir: path, models, registry,
    agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Synthetic host', extensions: [memoryExt, pingExt] } as never,
    compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' },
    transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } },
    policy: () => {}, controlPolicy: () => {},
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, ...opts.extra,
  } as never);
  hostRef = h; cleanup.push(async () => { await h.close(); await bundle.close(); });
  return { h, faux, seen, logs, bundle };
}
async function turn(h: DurableHost, e: SourceEnvelope) {
  await h.receive(e); await h.reconcile();
  const state = await h.runtime.harness.snapshot(Bindings, h.runtime.root.id, context);
  const id = state!.sources[sourceKey(e)]!.submissionId!;
  return (await h.runtime.harness.submission(id, context))!.wait(context);
}
const text = (m: any) => typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text ?? '').join('\n');
const hiddenTexts = (messages: readonly any[]) => messages.filter(m => m.role === 'user').map(text);
const allText = (messages: readonly any[]) => messages.map(text).join('\n---\n');
const judgeAll = (p = 0.9): ContextBundleOptions['judge'] => (() => (async request => ({
  model: 'fixture', probabilities: Object.fromEntries(Object.keys(request.questions).map(key => [key, key.startsWith('n') ? p : 0])),
})) as SemanticJudge);

it('adds a date hint even with recall off and memory view none, anchored to originalAt', async () => {
  const { h, seen } = await setup(await directory(), { memoryView: 'none', env: {} });
  // Admission happens later than the original message time; the hint must use originalAt.
  await turn(h, envelope(1, 'remind me about this tomorrow', BASE - 3 * 24 * 3600 * 1000));
  const request = allText(seen[0]!);
  expect(request).toMatch(/2023-11-11/);
  expect(request).not.toMatch(/2023-11-14/);
});

it('never writes hidden context into the transcript', async () => {
  const { h, seen } = await setup(await directory());
  await turn(h, envelope(1, 'see you tomorrow'));
  expect(allText(seen[0]!)).toMatch(/2023-11-1[45]/);
  const bindings = await h.runtime.harness.snapshot(Bindings, h.runtime.root.id, context);
  const id = bindings!.sources[sourceKey(envelope(1))]!.conversationId;
  const view = await (await h.runtime.harness.conversation(id, context))!.context(context);
  const persisted = JSON.stringify(view.entries) + JSON.stringify(view.contributions);
  expect(persisted).not.toMatch(/Date context|2023-11-15/);
  const ledger = await h.runtime.harness.snapshot(ContextLedger, id, context) as any;
  expect(Object.keys(ledger.turns)).toEqual([sourceKey(envelope(1))]);
});

it('injects identical hidden text on every tool round, once per turn', async () => {
  const { h, seen, faux } = await setup(await directory(), { responses: [answer(fauxToolCall('ping', {}), { stopReason: 'toolUse' }), answer('DONE')] });
  await turn(h, envelope(1, 'plan for tomorrow please'));
  expect(faux.state.callCount).toBe(2);
  const hint = (messages: readonly any[]) => hiddenTexts(messages).filter(t => /2023-11-15/.test(t));
  expect(hint(seen[0]!)).toHaveLength(1);
  expect(hint(seen[1]!)).toEqual(hint(seen[0]!));
});

it('recalls with a deterministic judge only when the flag is on, and injects once', async () => {
  const recall: RecallServices = { retrieve: async () => [candidate('a')], currentRevisions: async () => new Map([['a', 'r1']]) };
  const off = await setup(await directory(), { recall, judge: judgeAll(), env: {} });
  await turn(off.h, envelope(1, 'what coffee do I like?'));
  expect(allText(off.seen[0]!)).not.toMatch(/note a/);
  expect(off.logs).toHaveLength(0);
  const on = await setup(await directory(), { recall, judge: judgeAll(), env: { PI_TELEGRAM_MEMORY_RECALL: 'jev' } });
  await turn(on.h, envelope(1, 'what coffee do I like?'));
  expect(allText(on.seen[0]!)).toMatch(/note a/);
  expect(on.logs.length).toBeGreaterThan(0);
});

it('fails open on invalid flag, retrieval, judge and core failures', async () => {
  const errors: string[] = [];
  const bad = await setup(await directory(), { env: { PI_TELEGRAM_MEMORY_RECALL: 'maybe' }, onError: s => errors.push(s) });
  await turn(bad.h, envelope(1, 'tomorrow'));
  expect(errors).toContain('flag');
  expect(allText(bad.seen[0]!)).toMatch(/2023-11-15/);
  const throwing: RecallServices = { retrieve: async () => { throw new Error('index down'); }, currentRevisions: async () => new Map() };
  const r = await setup(await directory(), { env: { PI_TELEGRAM_MEMORY_RECALL: 'jev' }, recall: throwing, judge: judgeAll(), onError: s => errors.push(s) });
  expect(await turn(r.h, envelope(1, 'tomorrow'))).toMatchObject({ status: 'done' });
  expect(allText(r.seen[0]!)).toMatch(/2023-11-15/);
  const j = await setup(await directory(), { env: { PI_TELEGRAM_MEMORY_RECALL: 'jev' }, recall: { retrieve: async () => [candidate('a')], currentRevisions: async () => new Map([['a', 'r1']]) }, judge: () => (async () => { throw new Error('judge down'); }) as SemanticJudge });
  expect(await turn(j.h, envelope(1, 'what about coffee?'))).toMatchObject({ status: 'done' });
});

it('does nothing outside the current epoch scope', async () => {
  const { h, seen } = await setup(await directory(), { scoped: false });
  await turn(h, envelope(1, 'tomorrow'));
  expect(allText(seen[0]!)).not.toMatch(/2023-11-15/);
});

it('does not re-inject a recalled note while retained, and keeps earlier hidden text after restart', async () => {
  const path = await directory();
  const env = { PI_TELEGRAM_MEMORY_RECALL: 'jev' };
  const recall: RecallServices = { retrieve: async () => [candidate('a')], currentRevisions: async () => new Map([['a', 'r1']]) };
  const first = await setup(path, { recall, judge: judgeAll(), env });
  await turn(first.h, envelope(1, 'what coffee do I like?'));
  await turn(first.h, envelope(2, 'and what tea do I like?'));
  const count = (messages: readonly any[]) => allText(messages).split('note a').length - 1;
  expect(count(first.seen[0]!)).toBe(1);
  // Second request keeps the first turn's hidden text and does not add the note again.
  expect(count(first.seen[1]!)).toBe(1);
  await first.h.close();
  const next = await setup(path, { recall, judge: judgeAll(), env, responses: [answer('AFTER')] });
  await next.h.start();
  await turn(next.h, envelope(3, 'and juice?'));
  expect(count(next.seen[0]!)).toBe(1);
});

it('adds scoped core memory to the system prompt and stays silent without a vault', async () => {
  const { createMarkdownMemoryStore } = await import('../../.pi/skills/personal-memory/scripts/store.mjs');
  const path = await directory();
  const store = createMarkdownMemoryStore({ root: join(path, 'vault'), scope: 'household' });
  await store.add({ type: 'preference', title: 'Style', body: 'Prefers concise replies. #core' });
  const { h, seen } = await setup(path);
  await turn(h, envelope(1, 'hello'));
  const system = (seen[0] as any[]).filter(m => m.role === 'system').map(text).join('\n');
  expect(system).toContain('Prefers concise replies.');
  const none = await setup(await directory());
  expect(await turn(none.h, envelope(1, 'hello'))).toMatchObject({ status: 'done' });
  expect((none.seen[0] as any[]).filter(m => m.role === 'system').map(text).join('\n')).not.toContain('concise');
});

// ---- Native compaction, /new and restart: the dedup set follows what the conversation still retains ----
const control = (type: 'new' | 'compact', requestId: string = type) => ({ type, requestId, principal: 'person', target: { chatId: 10, threadId: 2 } }) as never;
const COMPACT = { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 } };
const recallEnv = { PI_TELEGRAM_MEMORY_RECALL: 'jev' };
const recallA: RecallServices = { retrieve: async () => [candidate('a')], currentRevisions: async () => new Map([['a', 'r1']]) };
const countA = (messages: readonly any[]) => allText(messages).split('note a').length - 1;
async function epochConversation(h: DurableHost) {
  const bindings = await h.runtime.harness.snapshot(Bindings, h.runtime.root.id, context);
  const id = bindings!.epochs[String(bindings!.epoch)]!;
  return { id, bindings: bindings!, view: await (await h.runtime.harness.conversation(id, context))!.context(context) };
}

/** Manual compaction is queued by the control; wait on the public context view until the summary replaces the history. */
async function compact(h: DurableHost) {
  await h.control(control('compact'));
  for (let i = 0; i < 100; i += 1) {
    const { view } = await epochConversation(h);
    if (!/what coffee do I like/.test(allText(view.contributions.flat() as any[]))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('compaction did not complete');
}

it('compaction drops retained sources, so a recalled note is injected again afterwards', async () => {
  const { h, seen } = await setup(await directory(), {
    recall: recallA, judge: judgeAll(), env: recallEnv, extra: { settings: COMPACT } as never,
    responses: [answer('ONE'), answer('TWO'), answer('SUMMARY'), answer('THREE')],
  });
  await turn(h, envelope(1, 'what coffee do I like?'));
  await turn(h, envelope(2, 'and what tea do I like?'));
  expect(countA(seen[0]!)).toBe(1);
  expect(countA(seen[1]!)).toBe(1); // deduplicated while retained
  const before = await epochConversation(h);
  await compact(h);
  const after = await epochConversation(h);
  // The retained context no longer carries the earlier user messages (public context() view).
  expect(allText(after.view.contributions.flat() as any[])).not.toMatch(/what coffee do I like/);
  expect(after.view.entries.length).not.toBe(before.view.entries.length);
  const ledger = await h.runtime.harness.snapshot(ContextLedger, after.id, context) as any;
  await turn(h, envelope(3, 'and juice?'));
  expect(countA(seen.at(-1)!)).toBe(1); // re-injected: the first injection was compacted away
  expect(allText(seen.at(-1)!)).toContain('SUMMARY');
  expect(allText(seen.at(-1)!)).not.toMatch(/what coffee do I like/);
  expect(Object.keys(ledger.turns).length).toBeGreaterThan(0); // ledger keeps its own bounded history
});

it('compaction followed by restart does not revive a dropped dedup record', async () => {
  const path = await directory();
  const first = await setup(path, {
    recall: recallA, judge: judgeAll(), env: recallEnv, extra: { settings: COMPACT } as never,
    responses: [answer('ONE'), answer('SUMMARY')],
  });
  await turn(first.h, envelope(1, 'what coffee do I like?'));
  await compact(first.h);
  await first.h.close();
  const next = await setup(path, { recall: recallA, judge: judgeAll(), env: recallEnv, extra: { settings: COMPACT } as never, responses: [answer('AFTER')] });
  await next.h.start();
  await turn(next.h, envelope(2, 'and juice?'));
  expect(countA(next.seen[0]!)).toBe(1);
  expect(allText(next.seen[0]!)).not.toMatch(/what coffee do I like/);
});

it('/new starts an empty conversation whose recall deduplication is independent', async () => {
  const { h, seen } = await setup(await directory(), {
    recall: recallA, judge: judgeAll(), env: recallEnv, responses: [answer('ONE'), answer('TWO')],
  });
  await turn(h, envelope(1, 'what coffee do I like?'));
  const first = await epochConversation(h);
  await h.control(control('new'));
  await turn(h, envelope(2, 'and what tea do I like?'));
  const second = await epochConversation(h);
  expect(second.bindings.epoch).toBe(first.bindings.epoch + 1);
  expect(second.id).not.toBe(first.id);
  expect(countA(seen[1]!)).toBe(1); // new epoch: the note is recalled afresh
  expect(allText(seen[1]!)).not.toMatch(/what coffee do I like/);
  const oldLedger = await h.runtime.harness.snapshot(ContextLedger, first.id, context) as any;
  const newLedger = await h.runtime.harness.snapshot(ContextLedger, second.id, context) as any;
  expect(Object.keys(oldLedger.turns)).toEqual([sourceKey(envelope(1))]);
  expect(Object.keys(newLedger.turns)).toEqual([sourceKey(envelope(2))]);
});

it('restores date, recall and core hidden context from the persisted ledger after restart', async () => {
  const { createMarkdownMemoryStore } = await import('../../.pi/skills/personal-memory/scripts/store.mjs');
  const path = await directory();
  await createMarkdownMemoryStore({ root: join(path, 'vault'), scope: 'household' }).add({ type: 'preference', title: 'Style', body: 'Prefers concise replies. #core' });
  const options = { recall: recallA, judge: judgeAll(), env: recallEnv };
  const first = await setup(path, { ...options, responses: [answer('ONE')] });
  await turn(first.h, envelope(1, 'what coffee do I like tomorrow?'));
  await first.h.close();
  const next = await setup(path, { ...options, responses: [answer('TWO')] });
  await next.h.start();
  // Make the restarted host rebuild its request from persisted state only; the recall service would now return nothing.
  await turn(next.h, envelope(2, 'thanks'));
  const request = next.seen[0]!;
  const hints = hiddenTexts(request).filter(t => /2023-11-15/.test(t));
  expect(hints).toHaveLength(1);
  expect(countA(request)).toBe(1);
  expect((request as any[]).filter(m => m.role === 'system').map(text).join('\n')).toContain('Prefers concise replies.');
  const { id, view } = await epochConversation(next.h);
  expect(JSON.stringify(view.entries) + JSON.stringify(view.contributions)).not.toMatch(/Date context|note a|2023-11-15/);
  const ledger = await next.h.runtime.harness.snapshot(ContextLedger, id, context) as any;
  expect(Object.keys(ledger.turns)).toEqual([sourceKey(envelope(1)), sourceKey(envelope(2))]);
});
