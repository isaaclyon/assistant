import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createModels, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { ScopedCredentialStore, createNativeProvider } from '../../src/durable/provider.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'native-provider-')); dirs.push(dir);
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({ openai: { type: 'api_key', key: 'synthetic' }, unrelated: { custom: 'preserve' } }), { mode: 0o600 });
  return { dir, path };
}
describe('native provider boundary', () => {
  it('coordinates two OS processes refreshing a shared credential exactly once', async () => {
    const { path } = await fixture();
    await writeFile(path, JSON.stringify({ openai: { type: 'oauth', access: 'expired', refresh: 'fake', expires: 0 } }));
    const module = pathToFileURL(resolve('src/durable/provider.ts')).href;
    const script = `import {ScopedCredentialStore} from ${JSON.stringify(module)};
      const s=await ScopedCredentialStore.open(process.argv[1],'test');
      await s.modify('openai',async c=>{ if(c.expires>0)return undefined;
      await new Promise(r=>setTimeout(r,80)); return {...c,access:'rotated',expires:9999999999999,refreshCount:(c.refreshCount??0)+1};}); s.close();`;
    await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, path], { timeout: 10_000 })));
    expect(JSON.parse(await readFile(path, 'utf8')).openai.refreshCount).toBe(1);
  });
  it('waits for a legacy-protocol writer then rereads its credential, preserving other providers', async () => {
    const { path } = await fixture();
    const store = await ScopedCredentialStore.open(path, 'test');
    const release = await lockfile.lock(path, { realpath: false, retries: 0, stale: 30_000 });
    const pending = store.modify('openai', async c => { expect(c).toEqual({ type: 'api_key', key: 'peer' }); return { type: 'api_key', key: 'native' }; });
    const data = JSON.parse(await readFile(path, 'utf8')); data.openai.key = 'peer'; await writeFile(path, JSON.stringify(data));
    await release(); await pending;
    expect(JSON.parse(await readFile(path, 'utf8')).unrelated).toEqual({ custom: 'preserve' });
    store.close(); await expect(store.read('openai')).rejects.toThrow('closed');
  });
  it('rejects public credential files, unsupported selected credentials and crashed native locks', async () => {
    const { path } = await fixture();
    await chmod(path, 0o644); await expect(ScopedCredentialStore.open(path, 'test')).rejects.toThrow('mode-0600');
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ version: 1, account: 'test', credentials: { openai: { type: 'api_key', key: 'synthetic' } } }));
    const store = await ScopedCredentialStore.open(path, 'test', 30, 'native');
    await expect(ScopedCredentialStore.open(path, 'wrong', 30, 'native')).rejects.toThrow('scope');
    await mkdir(`${path}.lock`);
    await expect(store.modify('openai', async c => c)).rejects.toThrow('reconcile');
  });
  it('validates private model settings and never reads ambient credentials after deletion', async () => {
    const { path, dir } = await fixture();
    const catalog = openaiProvider(); const model = catalog.getModels()[0]!;
    const settingsPath = join(dir, 'settings.json');
    const settings = { version: 1, account: 'test', provider: 'openai', modelId: model.id, thinkingLevel: getSupportedThinkingLevels(model)[0], modelIds: [model.id] };
    await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    const native = await createNativeProvider({ credentialPath: path, settingsPath, account: 'test' });
    expect((await native.models.getAuth('openai'))?.auth.apiKey).toBe('synthetic');
    await writeFile(path, '{}');
    await expect(native.models.getAuth('openai')).rejects.toThrow();
    native.close();
    await writeFile(path, JSON.stringify({ openai: { type: 'api_key', key: 'synthetic' } }));
    await writeFile(settingsPath, JSON.stringify({ ...settings, modelId: 'unknown', modelIds: undefined }));
    await expect(createNativeProvider({ credentialPath: path, settingsPath, account: 'test' })).rejects.toThrow('Unknown');
  });
  it('preserves failed OAuth refresh without falling back', async () => {
    const { path } = await fixture();
    const expired = { type: 'oauth', access: 'old', refresh: 'fake', expires: 0 } as const;
    await writeFile(path, JSON.stringify({ openai: expired }));
    const store = await ScopedCredentialStore.open(path, 'test');
    const models = createModels({ credentials: store, authContext: { env: async () => { throw new Error('ambient forbidden'); }, fileExists: async () => false } });
    models.setProvider(createProvider({ id: 'openai', models: openaiProvider().getModels(), api: openAIResponsesApi(), auth: { oauth: { name: 'Fixture', login: async () => expired, refresh: async () => { throw new Error('rejected'); }, toAuth: async c => ({ apiKey: c.access }) } } }));
    await expect(models.getAuth('openai')).rejects.toThrow();
    expect(await store.read('openai')).toEqual(expired);
  });
});

it('uses actual Responses serialization for positional instructions, schema replacement, max thinking and tool removal', async () => {
  const { path, dir } = await fixture();
  const catalog = openaiProvider();
  const model = catalog.getModels().find(m => getSupportedThinkingLevels(m).includes('max'))!;
  const settingsPath = join(dir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ version: 1, account: 'test', provider: 'openai', modelId: model.id, thinkingLevel: 'max' }), { mode: 0o600 });
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'response_fixture' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'fixture' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response_fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const api = openAIResponsesApi();
  const native = await createNativeProvider({ credentialPath: path, settingsPath, account: 'test', provider: createProvider({ id: 'openai', auth: catalog.auth, models: catalog.getModels(), api: {
    stream: (m, c, o) => api.stream(m, c, { ...o, fetch }), streamSimple: (m, c, o) => api.streamSimple(m, c, { ...o, fetch }),
  } }) });
  const { Type } = await import('@earendil-works/pi-ai');
  const tool = { name: 'fixture', description: 'Old', parameters: Type.Object({ text: Type.String() }) };
  const context: import('@earendil-works/pi-ai').Context = { messages: [
    { role: 'system', content: 'BASE', sections: { rules: 'OLD', obsolete: 'REMOVE' }, toolsAdded: [tool], timestamp: 0 },
    { role: 'user', content: 'Synthetic', timestamp: 1 },
    { role: 'system', content: 'ADDITIONAL', sections: { rules: 'NEW', obsolete: null }, toolsRemoved: [{ name: tool.name }], toolsAdded: [{ ...tool, description: 'Updated' }], timestamp: 2 },
  ] };
  const before = structuredClone(context);
  expect((await native.models.completeSimple(model, context, { reasoning: 'max', maxRetries: 0 })).stopReason).toBe('stop');
  expect(bodies[0]?.instructions).toBeUndefined();
  expect(bodies[0]?.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'developer', content: 'BASE\n\nOLD\n\nREMOVE' })]));
  expect(JSON.stringify(bodies[0])).toContain('Removed system prompt section');
  expect(bodies[0]?.tools).toEqual([expect.objectContaining({ name: 'fixture', description: 'Updated', parameters: expect.objectContaining({ required: ['text'] }) })]);
  expect(bodies[0]?.reasoning).toMatchObject({ effort: model.thinkingLevelMap?.max });
  expect(context).toEqual(before);
  context.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: tool.name }], timestamp: 3 });
  await native.models.completeSimple(model, context, { maxRetries: 0 });
  expect(bodies[1]?.tools ?? []).toEqual([]);
  native.close();
});

it('keeps a long native refresh owned against a legacy synchronous ten-second stale threshold', async () => {
  const { path } = await fixture();
  const store = await ScopedCredentialStore.open(path, 'test');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const refresh = store.modify('openai', async current => { entered.resolve(); await release.promise; return current; });
  try {
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 11_000));
    const script = `const lock=require('proper-lockfile');try{const release=lock.lockSync(process.argv[1],{realpath:false,retries:0});release();process.exit(9);}catch(error){if(error.code==='ELOCKED')process.exit(0);throw error;}`;
    await promisify(execFile)(process.execPath, ['-e', script, path], { timeout: 3000 });
  } finally { release.resolve(); await refresh; store.close(); }
}, 15_000);

it('registers only explicitly selected chat models in configured order', async () => {
  const { path, dir } = await fixture();
  const base = openaiProvider().getModels()[0]!;
  const provider = createProvider({ id: 'openai', auth: openaiProvider().auth, api: openAIResponsesApi(), models: ['older', 'standard', 'fast'].map(id => ({ ...base, id, name: id })) });
  const settingsPath = join(dir, 'settings.json');
  const settings = { version: 1, account: 'test', provider: 'openai', modelId: 'fast', thinkingLevel: 'off', modelIds: ['fast', 'standard'] };
  await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const native = await createNativeProvider({ credentialPath: path, settingsPath, account: 'test', provider });
  expect(native.models.getModels().map(model => model.id)).toEqual(['fast', 'standard']);
  expect(native.models.getAllModels().map(model => model.id)).toEqual(['fast', 'standard']);
  expect(native.models.getModel('openai', 'older')).toBeUndefined();
  native.close();
  for (const modelIds of [[], ['fast', 'fast'], ['missing'], ['standard'], 'fast']) {
    await writeFile(settingsPath, JSON.stringify({ ...settings, modelIds }));
    await expect(createNativeProvider({ credentialPath: path, settingsPath, account: 'test', provider })).rejects.toThrow(/model/i);
  }
});
