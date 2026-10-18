import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSupportedThinkingLevels, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { createNativeProvider } from '../../src/durable/provider.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.x`;

async function open(modelId: string, thinkingLevel: string, modelIds = ['gpt-6.1-sol', 'gpt-5.5', 'gpt-6-sol']) {
  const dir = await mkdtemp(join(tmpdir(), 'native-gpt61-')); dirs.push(dir);
  const credentialPath = join(dir, 'auth.json'), settingsPath = join(dir, 'settings.json');
  await writeFile(credentialPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'synthetic-refresh', expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
  await writeFile(settingsPath, JSON.stringify({ version: 1, account: 'test', provider: 'openai-codex', modelId, thinkingLevel, modelIds }), { mode: 0o600 });
  const bodies: Record<string, any>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    bodies.push(JSON.parse(body instanceof Uint8Array ? zstdDecompressSync(body).toString('utf8') : String(body)));
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
    const events = [{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const catalog = openaiCodexProvider(), api = openAICodexResponsesApi();
  const provider = { ...catalog, stream: (m: any, c: any, o: any) => api.stream(m, c, { ...o, fetch }), streamSimple: (m: any, c: any, o: any) => api.streamSimple(m, c, { ...o, fetch }) } as typeof catalog;
  const native = await createNativeProvider({ credentialPath, settingsPath, account: 'test', provider });
  return { native, bodies };
}

test('native catalog selects gpt-6.1-sol with its own limits and supported thinking levels, leaving other models unchanged', async () => {
  const { native } = await open('gpt-6.1-sol', 'max');
  try {
    const model = native.models.getModel('openai-codex', 'gpt-6.1-sol')!;
    expect(native.model).toEqual({ provider: 'openai-codex', modelId: 'gpt-6.1-sol' });
    expect(model).toMatchObject({ api: 'openai-codex-responses', maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: { off: null, minimal: null, max: 'max', xhigh: 'xhigh' } });
    // The native SDK catalog legitimately raises this window to 500k; the legacy patch's 272k is not forced.
    expect(model.contextWindow).toBe(500_000);
    expect(getSupportedThinkingLevels(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(native.models.getModel('openai-codex', 'gpt-6-sol')!.contextWindow).toBe(272_000);
    expect(getSupportedThinkingLevels(native.models.getModel('openai-codex', 'gpt-5.5')!)).toContain('off');
  } finally { native.close(); }
});

test('settings validation rejects off and minimal for gpt-6.1-sol and unknown levels, accepts max, and keeps off for other models', async () => {
  await expect(open('gpt-6.1-sol', 'off')).rejects.toThrow('Unsupported model thinking level');
  await expect(open('gpt-6.1-sol', 'minimal')).rejects.toThrow('Unsupported model thinking level');
  await expect(open('gpt-6.1-sol', 'ultra')).rejects.toThrow('Unsupported model thinking level');
  await expect(open('gpt-6.1-sol', 'max', ['gpt-5.5'])).rejects.toThrow('outside');
  for (const [id, level] of [['gpt-6.1-sol', 'max'], ['gpt-6.1-sol', 'low'], ['gpt-5.5', 'off'], ['gpt-6-sol', 'off']] as const) (await open(id, level)).native.close();
});

test('actual native Codex serialization sends gpt-6.1-sol requests without legacy Responses Lite patches', async () => {
  const seen: Record<string, unknown> = {};
  for (const level of ['high', 'max'] as ModelThinkingLevel[]) {
    const { native, bodies } = await open('gpt-6.1-sol', level);
    try {
      const model = native.models.getModel('openai-codex', 'gpt-6.1-sol')!;
      const result = await native.models.completeSimple(model, { messages: [{ role: 'user', content: 'Synthetic request', timestamp: 1 }] }, { transport: 'sse', maxRetries: 0, reasoning: level as Exclude<ModelThinkingLevel, 'off'> });
      expect(result.stopReason, result.errorMessage).toBe('stop');
      const body = bodies[0]!;
      expect(body.model).toBe('gpt-6.1-sol');
      expect(body.stream).toBe(true);
      expect(body.input).toEqual([expect.objectContaining({ role: 'user' })]);
      seen[level] = body.reasoning;
    } finally { native.close(); }
  }
  expect(seen).toMatchObject({ high: { effort: 'high' }, max: { effort: 'max' } });
});
