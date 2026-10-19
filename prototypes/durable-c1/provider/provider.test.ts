import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, createProvider, getSupportedThinkingLevels, Type, type Credential, type CredentialStore, type OAuthCredential, type Context, type ThinkingLevel } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, AssistantEntry, watchEvents } from '@earendil-works/pi-durable';

// Deliberately process-local: proves two Models owners coordinate through one store,
// not that this store provides cross-process locking or durable secret storage.
class SyntheticStore implements CredentialStore {
  values = new Map<string, Credential>();
  private tail: Promise<unknown> = Promise.resolve();
  async read(id: string) { return structuredClone(this.values.get(id)); }
  async list() { return [...this.values].map(([providerId, c]) => ({ providerId, type: c.type })); }
  modify(id: string, fn: (c: Credential | undefined) => Promise<Credential | undefined>) {
    const work = this.tail.then(async () => {
      const next = await fn(await this.read(id));
      if (next) this.values.set(id, structuredClone(next));
      return this.read(id);
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
  async delete(id: string) { await this.modify(id, async () => { this.values.delete(id); return undefined; }); }
}
const isolatedAuth = { env: async () => undefined, fileExists: async () => false };
const catalog = openaiProvider();
const model = catalog.getModels().find(m => getSupportedThinkingLevels(m).includes('max'))!;
function choose(models: ReturnType<typeof createModels>, id: string, thinking: ThinkingLevel) {
  const selected = models.getModel('openai', id);
  if (!selected) throw new Error('Unknown model');
  if (!getSupportedThinkingLevels(selected).includes(thinking)) throw new Error('Unsupported thinking');
  return selected;
}
function sse(text = 'Synthetic answer') {
  const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_test' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
  ];
  return new Response(new ReadableStream({ async start(controller) {
    for (const event of events) {
      controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function setup(fetch: typeof globalThis.fetch) {
  const store = new SyntheticStore();
  store.values.set('openai', { type: 'api_key', key: 'synthetic-never-real' });
  const models = createModels({ credentials: store, authContext: isolatedAuth });
  const api = openAIResponsesApi();
  models.setProvider(createProvider({ id: 'openai', auth: catalog.auth, models: catalog.getModels(), api: {
    stream: (m, c, o) => api.stream(m, c, { ...o, fetch }),
    streamSimple: (m, c, o) => api.streamSimple(m, c, { ...o, fetch }),
  } }));
  return models;
}

describe('C1 native provider boundary (synthetic transport only)', () => {
  it('coordinates refresh across Models owners and never falls back after failed stored OAuth', async () => {
    const store = new SyntheticStore();
    const expired: OAuthCredential = { type: 'oauth', access: 'expired-synthetic', refresh: 'synthetic-refresh', expires: 0 };
    store.values.set('openai', expired);
    let refreshes = 0;
    let ambientReads = 0;
    let fail = false;
    const provider = createProvider({ id: 'openai', models: catalog.getModels(), api: openAIResponsesApi(), auth: {
      apiKey: catalog.auth.apiKey,
      oauth: { name: 'Synthetic OAuth', login: async () => expired,
        refresh: async c => { refreshes++; await Promise.resolve(); if (fail) throw new Error('synthetic refresh rejected'); return { ...c, access: 'rotated-synthetic', expires: Date.now() + 3600000 }; },
        toAuth: async c => ({ apiKey: c.access }) },
    } });
    const owners = [0, 1].map(() => { const m = createModels({ credentials: store, authContext: { ...isolatedAuth, env: async () => { ambientReads++; return 'synthetic-env'; } } }); m.setProvider(provider); return m; });
    const auth = await Promise.all(Array.from({ length: 12 }, (_, i) => owners[i % 2]!.getAuth('openai')));
    expect(refreshes).toBe(1);
    expect(auth.every(a => a?.auth.apiKey === 'rotated-synthetic')).toBe(true);
    expect(await store.list()).toEqual([{ providerId: 'openai', type: 'oauth' }]);
    store.values.set('openai', expired); fail = true;
    await expect(owners[0]!.getAuth('openai')).rejects.toThrow();
    expect(await store.read('openai')).toEqual(expired);
    expect(ambientReads).toBe(0);
  });

  it('validates catalog selection and supported max thinking', () => {
    const models = setup(async () => { throw new Error('No request expected'); });
    expect(model).toBeDefined();
    expect(choose(models, model.id, 'max').id).toBe(model.id);
    expect(() => choose(models, 'nonexistent-synthetic', 'high')).toThrow('Unknown model');
    const withoutMax = catalog.getModels().find(m => !getSupportedThinkingLevels(m).includes('max'))!;
    expect(() => choose(models, withoutMax.id, 'max')).toThrow('Unsupported thinking');
  });

  it('serializes updated instructions and executable tools using the actual Responses adapter', async () => {
    const bodies: any[] = [];
    const models = setup(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(); });
    const tool = { name: 'exec_command', description: 'Run synthetic command', parameters: Type.Object({ cmd: Type.String() }) };
    const context: Context = { messages: [
      { role: 'system', content: 'BASE', sections: { rules: 'OLD_RULES', obsolete: 'REMOVE_ME' }, toolsAdded: [tool, { ...tool, name: 'removed_tool' }], timestamp: 0 },
      { role: 'user', content: 'Inspect synthetic workspace', timestamp: 1 },
      { role: 'system', content: 'ADDITIONAL_INSTRUCTIONS', sections: { rules: 'NEW_RULES', obsolete: null }, toolsRemoved: [{ name: 'removed_tool' }, { name: tool.name }], toolsAdded: [{ ...tool, description: 'Updated command schema' }], timestamp: 2 },
    ] };
    const before = structuredClone(context);
    const result = await models.completeSimple(model, context, { reasoning: 'max', maxRetries: 0 });
    expect(result.stopReason).toBe('stop');
    const body = bodies[0];
    expect(JSON.stringify(body)).toContain('NEW_RULES');
    // Native positional system messages retain the old prefix and explicitly patch it.
    expect(body.instructions).toBeUndefined();
    expect(body.input[0]).toMatchObject({ role: 'developer', content: 'BASE\n\nOLD_RULES\n\nREMOVE_ME' });
    expect(body.input[2].content).toContain('Removed system prompt section \"obsolete\".');
    expect(JSON.stringify(body)).toContain('ADDITIONAL_INSTRUCTIONS');
    expect(body.tools.map((t: any) => t.name)).toEqual(['exec_command']);
    expect(body.tools[0]).toMatchObject({ type: 'function', description: 'Updated command schema', parameters: { properties: { cmd: { type: 'string' } }, required: ['cmd'] } });
    expect(body.reasoning.effort).toBe(model.thinkingLevelMap?.max);
    expect(context).toEqual(before);
    context.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: tool.name }], timestamp: 3 });
    await models.completeSimple(model, context, { maxRetries: 0 });
    expect(bodies[1].tools ?? []).toEqual([]);
  });

  it('streams, retries a transient failure, and commits one final answer through Harness', async () => {
    const bodies: any[] = [];
    const models = setup(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: 'synthetic overloaded' } }), { status: 503, headers: { 'content-type': 'application/json' } });
      return sse();
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'synthetic', tools: [defineTool({ name: 'echo', description: 'Echo synthetic text', parameters: Type.Object({ text: Type.String() }), execute: async a => ({ output: [{ type: 'text', text: a.text }] }) })] }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { stream: { maxRetries: 0 }, retry: { maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false }, progress: { partialIntervalMs: 0 } } }, ctx);
    try {
      const root = await harness.root(ctx, { agent: { model: { provider: 'openai', modelId: model.id }, thinkingLevel: 'max', instructions: 'C1_SYNTHETIC_INSTRUCTIONS' } });
      const events: string[] = [];
      const watch = await watchEvents(harness, root.id, ctx);
      watch.start(async batch => { events.push(...batch.map(e => e.type)); });
      const settled = await (await root.submit({ type: 'input', content: 'Synthetic hello', requestId: 'provider-c1' }, ctx)).wait(ctx);
      expect(settled.status).toBe('done');
      if (settled.status !== 'done' || settled.type !== 'input') throw new Error('Input did not settle');
      const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), ctx);
      expect(JSON.stringify(answer)).toContain('Synthetic answer');
      expect(bodies).toHaveLength(2);
      expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
      expect(bodies[1].prompt_cache_key).toBeTruthy();
      expect(JSON.stringify(bodies[1])).toContain('C1_SYNTHETIC_INSTRUCTIONS');
      expect(bodies[1].tools.map((t: any) => t.name)).toEqual(['echo']);
      expect(events).toContain('message_update');
      await watch.stop();
    } finally { await harness.close(ctx); }
  });
});
