import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import { loadNativeConfig, type NativeConfig } from '../../src/durable/config.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

// Browser domain services are replaced through the browserServices seam. Everything else is production.
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const SECRET = 'synthetic-secret-value-9f3a';
const gateOf = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(path)); else out.push(path);
  }
  return out;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'native-browser-app-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'), workspaceCwd = join(directory, 'workspace'), vaultRoot = join(directory, 'vault');
  const agentDir = join(directory, 'agent'), configRoot = join(directory, 'browser-config'), runtimeDir = join(directory, 'browser-runtime'), dataDir = join(directory, 'browser-data');
  await Promise.all([stateDir, workspaceCwd, vaultRoot, agentDir, configRoot, runtimeDir, dataDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(agentDir, 'telegram.json'), JSON.stringify({profiles:{'synthetic-profile':{botToken:'123:runtime',allowedUserId:42}}}), { mode: 0o600 });
  const config: NativeConfig = {
    version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40), resourceRoot: resolve(import.meta.dirname, '../..'), workspaceCwd, stateDir,
    capabilityProfile: 'durable-browser-test', account: 'test', credentialPath: join(directory, 'unused-auth'), settingsPath: join(directory, 'unused-settings'), jobsRole: 'disabled', idleHours: 0,
    transport: { mode: 'broker', socketPath: join(directory, 'unused.sock'), botId: 123, allowedUserId: 42 }, historyDir: join(stateDir, 'durable'), inboxPath: join(stateDir, 'inbox.db'), runtimeMetadataPath: join(stateDir, 'runtime.json'),
    memory: { vaultRoot, gitAutocommit: false, legacySessionRoots: [], timeZone: 'UTC', recall: 'off', semantic: 'off' },
    google: { account: 'owner@example.com', gog: { binary: join(directory, 'fake-gog'), passwordFile: join(directory, 'password'), home: join(directory, 'gog-home') }, calendarTargets: { account: 'owner@example.com', personal: 'personal-id', thingsToDo: 'things-id' } },
    browser: { agentDir, telegramProfile: 'synthetic-profile', credentialScope: 'synthetic-scope', configRoot, runtimeDir, dataDir, endpoints: { bindAddress: '10.20.30.2', inputOrigin: 'https://assistant.synthetic.ts.net:8446', takeoverOrigin: 'https://assistant.synthetic.ts.net:8447' } },
  } as unknown as NativeConfig;
  await mkdir(config.google!.gog!.home, { mode: 0o700 }); await writeFile(config.google!.gog!.passwordFile, 'fictional-password', { mode: 0o600 });
  await writeFile(config.google!.gog!.binary, `#!${process.execPath}\nconsole.log('{}');\n`, { mode: 0o700 });

  const inputCalls: any[] = [], takeoverCalls: any[] = [];
  const behavior = { input: async (_o: any): Promise<any> => ({ status: 'submitted' }), takeover: async (_o: any): Promise<any> => ({ status: 'handed_back' }) };
  const services = {
    input: async (options: any) => { inputCalls.push(options); return behavior.input(options); },
    takeover: async (options: any) => { takeoverCalls.push(options); return behavior.takeover(options); },
    candidates: async () => ({ ok: true, candidates: [] }),
  };
  let hooks!: NativeTelegramHooks; let nextId = 100; const finals: string[] = [], requests: any[] = []; const fatal = vi.fn();
  const raw = { start: async (h: NativeTelegramHooks) => { hooks = h; return 'ready' as const; }, stop: async () => {}, deliver: async (_t: unknown, text: string) => { finals.push(text); return ++nextId; }, present: async () => ++nextId, edit: async () => {}, answerCallback: async () => true };
  let app: Awaited<ReturnType<typeof createNativeApplication>> | undefined; cleanup.push(async () => app?.close());
  const open = async (responses: any[] = []) => {
    const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
    faux.setResponses(responses.map(response => (request: any) => { requests.push(structuredClone(request)); return typeof response === 'function' ? response(request) : response; }));
    const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
    app = await createNativeApplication(config, { provider: { models, provider: faux.provider, model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off', close: async () => {} }, transport: raw, onFatal: fatal, onTransportFailure: () => {}, browserServices: services } as any);
    await app.start(); return app;
  };
  let updateId = 1;
  const accept = (text: string, chat: Record<string, unknown> = { id: 42, type: 'private' }, from = 42) => { const id = updateId++; return hooks.accept({ update_id: id, message: { message_id: 1000 + id, date: 1700000000 + id, from: { id: from }, chat, text } } as any); };
  return { directory, config, open, accept, finals, requests, fatal, inputCalls, takeoverCalls, behavior, stateDir, close: async () => { await app?.close(); app = undefined; }, app: () => app };
}
const call = (name: string, args: unknown, id?: string) => fauxAssistantMessage({ ...fauxToolCall(name, args as never), ...(id ? { id } : {}) }, { stopReason: 'toolUse' });
const resultText = (r: any) => { const m = r.messages.filter((m: any) => m.role === 'toolResult').at(-1); return typeof m.content === 'string' ? m.content : m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'); };
const form = { session: 'synthetic-session', pageUrl: 'https://example.test/login', resumeUrl: 'https://example.test/', fields: [{ kind: 'password', selector: '#password' }], submitSelector: '#submit' };
const takeover = { session: 'synthetic-session', resumeUrl: 'https://example.test/' };
const login = { session: 'synthetic-session', pageUrl: 'https://example.test/login', resumeUrl: 'https://example.test/' };

test('registers the four browser tools and returns only a fixed status, whatever the domain service returns', async () => {
  const s = await setup();
  s.behavior.input = async () => ({ status: 'submitted', password: SECRET, details: { token: SECRET } });
  s.behavior.takeover = async () => ({ status: 'handed_back', copiedCredentialItem: 'Item', cookie: SECRET });
  const seen: string[] = [];
  await s.open([
    call('private_browser_input', form), (r: any) => { seen.push(resultText(r)); return call('browser_takeover', takeover); },
    (r: any) => { seen.push(resultText(r)); return call('private_browser_login', login); },
    (r: any) => { seen.push(resultText(r)); return call('private_opentable_login', { session: 'synthetic-session' }); },
    (r: any) => { seen.push(resultText(r)); return fauxAssistantMessage('BROWSER_DONE'); },
  ]);
  await s.accept('Sign me in.'); await vi.waitFor(() => expect(s.finals).toContain('BROWSER_DONE'), { timeout: 8000 });
  expect(s.requests[0].tools?.map((t: any) => t.name) ?? s.requests[0].messages.flatMap((m: any) => m.toolsAdded ?? []).map((t: any) => t.name)).toEqual(expect.arrayContaining(['private_browser_input', 'browser_takeover', 'private_browser_login', 'private_opentable_login']));
  expect(seen.map(x => JSON.parse(x).status)).toEqual(['submitted', 'handed_back', expect.any(String), expect.any(String)]);
  for (const text of seen) { expect(text).not.toContain(SECRET); expect(Object.keys(JSON.parse(text))).toEqual(['status']); }
  // Chat and config come from the verified Telegram actor and native config, never from model arguments.
  expect(s.inputCalls[0].chatId).toBe(42);
  expect(s.inputCalls[0].config).toMatchObject({ agentDir: s.config.browser!.agentDir, telegramProfile: 'synthetic-profile', credentialScope: 'synthetic-scope' });
  expect(s.takeoverCalls.length).toBeGreaterThanOrEqual(1);
  expect(s.fatal).not.toHaveBeenCalled();
});

test('credentials and service extras never reach the model, history files or debug output', async () => {
  const s = await setup();
  s.behavior.input = async () => ({ status: 'submitted', password: SECRET, error: new Error(SECRET).message });
  await s.open([call('private_browser_input', { ...form, fields: [{ kind: 'password', selector: '#password' }] }), fauxAssistantMessage('FIN')]);
  await s.accept('Sign in with my password.'); await vi.waitFor(() => expect(s.finals).toContain('FIN'), { timeout: 8000 });
  expect(JSON.stringify(s.requests)).not.toContain(SECRET); expect(JSON.stringify(s.finals)).not.toContain(SECRET);
  const files = (await Promise.all([s.stateDir, s.directory].map(listFiles))).flat();
  for (const file of new Set(files)) { if ((await stat(file)).size > 5_000_000) continue; expect((await readFile(file)).includes(SECRET), file).toBe(false); }
});

test('other tools are blocked while a private operation is active and resume afterwards', async () => {
  const s = await setup(); const gate = gateOf(); const started = gateOf();
  s.behavior.input = async () => { started.release(); await gate.promise; return { status: 'submitted' }; };
  const second: string[] = [];
  await s.open([
    fauxAssistantMessage([fauxToolCall('private_browser_input', form as never), fauxToolCall('browser_takeover', takeover as never)], { stopReason: 'toolUse' }),
    (r: any) => { second.push(resultText(r)); return fauxAssistantMessage('PARALLEL_DONE'); },
  ]);
  await s.accept('Sign in and hand over.'); await started.promise;
  // Takeover cannot start (or is rejected) while the input operation owns the browser.
  expect(s.takeoverCalls).toHaveLength(0);
  // Exercise the production registry wrapper directly: it must refuse even a
  // tool whose authorization would otherwise require a valid Harness API.
  const read = s.app()!.host.config.registry.snapshot().tools().find(t => t.tool.name === 'read')!.tool;
  await expect(read.execute({ path: '/unused' } as never, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow(/Private browser/);
  gate.release(); await vi.waitFor(() => expect(s.finals).toContain('PARALLEL_DONE'), { timeout: 8000 });
  expect(s.inputCalls).toHaveLength(1);
  expect(s.fatal).not.toHaveBeenCalled();
});

test('closing the application cancels the active private operation and waits for its cleanup', async () => {
  const s = await setup(); const started = gateOf(); const events: string[] = [];
  s.behavior.takeover = (options: any) => new Promise(resolve => {
    started.release();
    options.signal.addEventListener('abort', () => { events.push('abort'); setTimeout(() => { events.push('cleaned'); resolve({ status: 'cancelled' }); }, 150); }, { once: true });
  });
  await s.open([call('browser_takeover', takeover), fauxAssistantMessage('NEVER_NEEDED')]);
  await s.accept('Take over the browser.'); await started.promise;
  const harness=s.app()!.host.runtime.harness,originalClose=harness.close.bind(harness);
  const harnessClose=vi.spyOn(harness,'close').mockImplementation(async (...args)=>{events.push('harness');return originalClose(...args);});
  await s.close();
  expect(events.indexOf('abort')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('cleaned')).toBeGreaterThan(events.indexOf('abort'));
  expect(harnessClose).toHaveBeenCalled();expect(events.indexOf('harness')).toBeGreaterThan(events.indexOf('cleaned'));
  expect(s.fatal).not.toHaveBeenCalled();
});

test('abort waits for private cleanup, keeps the guard held and then permits a new epoch', async () => {
  const s = await setup(), started = gateOf(), aborted = gateOf(), drain = gateOf();
  cleanup.push(async () => drain.release());
  s.behavior.input = (options: any) => new Promise(resolve => {
    options.signal.addEventListener('abort', () => {
      aborted.release();
      void drain.promise.then(() => resolve({ status: 'cancelled' }));
    }, { once: true });
    started.release();
  });
  const app = await s.open([call('private_browser_input', form), fauxAssistantMessage('ABORTED')]);
  await s.accept('Sign me in.'); await started.promise;
  await expect(app.host.rotate('telegram-control:123:700', s.config.principal, { chatId: 42 })).rejects.toThrow(/busy/i);
  let finished = false;
  const stop = app.host.abort('telegram-control:123:701', s.config.principal, { chatId: 42 }).then(() => { finished = true; });
  await aborted.promise;
  const read = app.host.config.registry.snapshot().tools().find(t => t.tool.name === 'read')!.tool;
  await expect(read.execute({ path: '/unused' } as never, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow(/Private browser/);
  expect(finished).toBe(false);
  drain.release(); await stop;
  await app.host.rotate('telegram-control:123:702', s.config.principal, { chatId: 42 });
  expect(s.fatal).not.toHaveBeenCalled();
});

test('non-private or other-actor sources are rejected before any browser effect', async () => {
  const s = await setup();
  await s.open([call('browser_takeover', takeover), fauxAssistantMessage('SHOULD_NOT_RUN')]);
  await s.accept('Take over.', { id: -100123, type: 'supergroup' }); await s.accept('Take over.', { id: 99, type: 'private' }, 99);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(s.takeoverCalls).toHaveLength(0); expect(s.inputCalls).toHaveLength(0); expect(s.requests).toHaveLength(0); expect(s.finals).not.toContain('SHOULD_NOT_RUN');
});

test('profile needs the Isaac principal and browser configuration, and reopening does not repeat a finished operation', async () => {
  const s = await setup(); const { historyDir, inboxPath, runtimeMetadataPath, ...input } = s.config; const path = join(s.directory, 'instance.json');
  const load = async (value: unknown) => { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return loadNativeConfig(path); };
  expect((await load(input)).capabilityProfile).toBe('durable-browser-test');
  for (const principal of ['emma', 'household', 'engineering']) await expect(load({ ...input, principal })).rejects.toThrow(/principal/);
  await expect(load({ ...input, browser: undefined })).rejects.toThrow();
  await expect(load({ ...input, browser: { ...input.browser, endpoints: undefined } })).rejects.toThrow(/endpoint/i);
  const ordinary = { ...input.transport, mode: 'ordinary' };
  const ordinaryTransport = (profile: string, configPath: string) => ({ mode: 'ordinary', profile, configPath, locksPath: join(s.directory, 'locks'), botId: 123, allowedUserId: 42 });
  const { endpoints, ...bare } = input.browser!;
  void ordinary;
  expect((await load({ ...input, browser: bare, transport: ordinaryTransport('synthetic-profile', join(bare.agentDir, 'telegram.json')) })).browser?.agentDir).toBe(bare.agentDir);
  await expect(load({ ...input, browser: bare, transport: ordinaryTransport('other-profile', join(bare.agentDir, 'telegram.json')) })).rejects.toThrow(/profile/i);
  await expect(load({ ...input, browser: bare, transport: ordinaryTransport('synthetic-profile', join(s.directory, 'elsewhere.json')) })).rejects.toThrow(/profile/i);
  await expect(load({ ...input, google: undefined })).rejects.toThrow();
  await expect(load({ ...input, memory: undefined })).rejects.toThrow();
  await s.open([call('browser_takeover', takeover), fauxAssistantMessage('ONCE')]);
  await s.accept('Take over once.'); await vi.waitFor(() => expect(s.finals).toContain('ONCE'), { timeout: 8000 });
  const before = s.takeoverCalls.length; await s.close(); await s.open();
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(s.takeoverCalls).toHaveLength(before); expect(s.fatal).not.toHaveBeenCalled();
});
