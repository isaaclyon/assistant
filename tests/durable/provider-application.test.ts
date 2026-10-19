import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { NativeFast } from '../../src/durable/provider-fast.js';
import { context } from '../../src/durable/ingress.js';
import { createNativeApplication } from '../../src/durable/application.js';
import { loadNativeConfig, type NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

// Browser domain services are replaced through the browserServices seam. Everything else is production.
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const gateOf = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(path)); else out.push(path);
  }
  return out;
}

async function setup(profile = 'durable-provider-test') {
  const directory = await mkdtemp(join(tmpdir(), 'native-provider-app-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'), workspaceCwd = join(directory, 'workspace'), vaultRoot = join(directory, 'vault');
  const agentDir = join(directory, 'agent'), configRoot = join(directory, 'browser-config'), runtimeDir = join(directory, 'browser-runtime'), dataDir = join(directory, 'browser-data');
  await Promise.all([stateDir, workspaceCwd, vaultRoot, agentDir, configRoot, runtimeDir, dataDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(agentDir, 'telegram.json'), JSON.stringify({profiles:{'synthetic-profile':{botToken:'123:runtime',allowedUserId:42}}}), { mode: 0o600 });
  const config: NativeConfig = {
    version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40), resourceRoot: resolve(import.meta.dirname, '../..'), workspaceCwd, stateDir,
    capabilityProfile: profile, account: 'test', credentialPath: join(directory, 'unused-auth'), settingsPath: join(directory, 'unused-settings'), jobsRole: 'disabled', idleHours: 0,
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
  let hooks!: NativeTelegramHooks; let nextId = 100; const finals: string[] = [], presented: string[] = [], requests: any[] = []; const fatal = vi.fn();
  const raw = { start: async (h: NativeTelegramHooks) => { hooks = h; return 'ready' as const; }, stop: async () => {}, deliver: async (_t: unknown, text: string) => { finals.push(text); return ++nextId; }, present: async (_t: unknown, value: { text: string }) => { presented.push(value.text); return ++nextId; }, edit: async () => {}, answerCallback: async () => true };
  let app: Awaited<ReturnType<typeof createNativeApplication>> | undefined; cleanup.push(async () => app?.close());
  const open = async (responses: any[] = [], plainModel = false) => {
    const faux = fauxProvider({ ...(profile === 'durable-provider-test' && !plainModel ? { provider: 'openai-codex', api: 'openai-codex-responses' } : {}), tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
    faux.setResponses(responses.map(response => (request: any) => { requests.push(structuredClone(request)); return typeof response === 'function' ? response(request) : response; }));
    const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
    app = await createNativeApplication(config, { provider: { models, provider: faux.provider, model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off', close: async () => {} }, transport: raw, onFatal: fatal, onTransportFailure: () => {}, browserServices: services } as any);
    await app.start(); return app;
  };
  let updateId = 1;
  const accept = (text: string, chat: Record<string, unknown> = { id: 42, type: 'private' }, from = 42, fixedId?: number) => { const id = fixedId ?? updateId++; return hooks.accept({ update_id: id, message: { message_id: 1000 + id, date: 1700000000 + id, from: { id: from }, chat, text } } as any); };
  return { directory, config, open, accept, presented, finals, requests, fatal, inputCalls, takeoverCalls, behavior, stateDir, close: async () => { await app?.close(); app = undefined; }, app: () => app };
}


const gate = gateOf;
const fastState = async (s: Awaited<ReturnType<typeof setup>>) => { const host = s.app()!.host; return (await host.runtime.harness.snapshot(NativeFast, host.runtime.root.id, context)) as { active: boolean; saved: boolean; commands: Record<string, unknown> } | undefined; };
const settled = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
const wait = { timeout: 8000 };
const ok = (text: string) => fauxAssistantMessage(text);

test('authenticated /fast on, off and status change the saved preference and answer without invoking the model', async () => {
  const s = await setup(); await s.open([ok('UNUSED')]);
  await s.accept('/fast on'); await vi.waitFor(async () => expect((await fastState(s))?.active).toBe(true), wait);
  expect(await fastState(s)).toMatchObject({ active: true, saved: true });
  const shown = s.presented.length; expect(shown).toBeGreaterThan(0);
  await s.accept('/fast status'); await vi.waitFor(() => expect(s.presented.length).toBeGreaterThan(shown), wait);
  expect(await fastState(s)).toMatchObject({ active: true, saved: true });
  await s.accept('/fast off'); await vi.waitFor(async () => expect(await fastState(s)).toMatchObject({ active: false, saved: false }), wait);
  expect(s.requests).toHaveLength(0); expect(s.fatal).not.toHaveBeenCalled();
});

test('malformed /fast arguments are rejected with guidance and never reach the model or the preference', async () => {
  const s = await setup(); await s.open([ok('SHOULD_NOT_RUN')]);
  for (const text of ['/fast maybe', '/fast on now', '/fast ON please', '/fast\u00a0priority']) {
    const before = s.presented.length+s.finals.length; await s.accept(text); await vi.waitFor(() => expect(s.presented.length+s.finals.length).toBeGreaterThan(before), wait);
  }
  await settled();
  expect(s.requests).toHaveLength(0); expect(s.finals).not.toContain('SHOULD_NOT_RUN');
  expect((await fastState(s))?.saved ?? false).toBe(false);
});

test('outsiders and group chats cannot change fast mode or reach the model', async () => {
  const s = await setup(); await s.open([ok('SHOULD_NOT_RUN')]);
  await s.accept('/fast on', { id: 99, type: 'private' }, 99); await s.accept('/fast on', { id: -100123, type: 'supergroup' });
  await s.accept('/usage', { id: 99, type: 'private' }, 99); await settled();
  expect(s.presented).toHaveLength(0); expect(s.requests).toHaveLength(0);
  expect((await fastState(s))?.saved ?? false).toBe(false);
});

test('/usage with fake authentication explains that usage is unavailable and makes no network call', async () => {
  const fetchSpy = vi.fn(async () => { throw new Error('network must not be used'); }); vi.stubGlobal('fetch', fetchSpy); cleanup.push(async () => { vi.unstubAllGlobals(); });
  const s = await setup(); await s.open([ok('UNUSED')]);
  await s.accept('/usage'); await vi.waitFor(() => expect(s.presented.length).toBe(1), wait);
  expect(s.presented[0]!.trim().length).toBeGreaterThan(0); expect(s.presented[0]).not.toMatch(/token|bearer/i);
  expect(fetchSpy).not.toHaveBeenCalled(); expect(s.requests).toHaveLength(0); expect(s.fatal).not.toHaveBeenCalled();
});

test('/fast is refused for a model without priority support and leaves the preference untouched', async () => {
  const s = await setup(); await s.open([ok('UNUSED')], true);
  await s.accept('/fast on'); await vi.waitFor(() => expect(s.presented.length+s.finals.length).toBe(1), wait);
  expect((await fastState(s))?.saved ?? false).toBe(false); expect(s.requests).toHaveLength(0);
});

test('a /fast change during a running response is saved but applies only after the response settles', async () => {
  const s = await setup(); const hold = gate(), started = gate(); cleanup.push(async()=>hold.release());
  await s.open([async () => { started.release(); await hold.promise; return ok('FIRST_DONE'); }, ok('SECOND_DONE')]);
  await s.accept('Work on something.'); await started.promise;
  await s.accept('/fast on'); await vi.waitFor(async () => expect((await fastState(s))?.saved).toBe(true), wait);
  expect((await fastState(s))?.active).toBe(false);
  await settled(); expect((await fastState(s))?.active).toBe(false); expect(s.finals).not.toContain('FIRST_DONE');
  hold.release(); await vi.waitFor(() => expect(s.finals).toContain('FIRST_DONE'), wait);
  await vi.waitFor(async () => expect((await fastState(s))?.active).toBe(true), wait);
  expect(s.fatal).not.toHaveBeenCalled();
});

test('a queued message does not let a pending /fast change apply before every accepted turn has finished', async () => {
  const s = await setup(); const hold = gate(), started = gate(); cleanup.push(async()=>hold.release());
  await s.open([async () => { started.release(); await hold.promise; return ok('A_DONE'); }, ok('B_DONE')]);
  await s.accept('First request.'); await started.promise;
  await s.accept('Second request.'); await s.accept('/fast on');
  await vi.waitFor(async () => expect((await fastState(s))?.saved).toBe(true), wait);
  expect((await fastState(s))?.active).toBe(false);
  hold.release(); await vi.waitFor(() => expect(s.finals).toEqual(expect.arrayContaining(['A_DONE'])), wait);
  await vi.waitFor(async () => expect((await fastState(s))?.active).toBe(true), wait);
  expect(s.finals).toContain('B_DONE');
  expect(s.fatal).not.toHaveBeenCalled();
});

test('replaying an older command does not overwrite a newer choice', async () => {
  const s = await setup(); await s.open([ok('UNUSED')]);
  await s.accept('/fast on', undefined, 42, 5000); await vi.waitFor(async () => expect((await fastState(s))?.saved).toBe(true), wait);
  await s.accept('/fast off', undefined, 42, 5001); await vi.waitFor(async () => expect((await fastState(s))?.saved).toBe(false), wait);
  await s.accept('/fast on', undefined, 42, 5000); await settled();
  expect((await fastState(s))?.saved).toBe(false);
  await s.close(); await s.open([ok('UNUSED')]); await settled();
  await s.accept('/fast on', undefined, 42, 5000); await settled();
  expect((await fastState(s))?.saved).toBe(false); expect(s.fatal).not.toHaveBeenCalled();
});

test('a saved preference survives restart and becomes active on the next accepted work', async () => {
  const s = await setup(); await s.open([ok('UNUSED')]);
  await s.accept('/fast on'); await vi.waitFor(async () => expect((await fastState(s))?.saved).toBe(true), wait);
  await s.close(); await s.open([ok('AFTER_RESTART')]);
  expect(await fastState(s)).toMatchObject({ saved: true });
  await s.accept('Hello again.'); await vi.waitFor(() => expect(s.finals).toContain('AFTER_RESTART'), wait);
  expect(await fastState(s)).toMatchObject({ active: true, saved: true }); expect(s.fatal).not.toHaveBeenCalled();
});

test('the older browser profile does not enable /fast or /usage and never forwards them to the model', async () => {
  const s = await setup('durable-browser-test'); await s.open([ok('SHOULD_NOT_RUN')]);
  await s.accept('/fast on'); await s.accept('/usage'); await vi.waitFor(() => expect(s.presented.length + s.finals.length).toBeGreaterThanOrEqual(2), wait); await settled();
  expect(s.requests).toHaveLength(0); expect(s.finals).not.toContain('SHOULD_NOT_RUN');
  expect(await fastState(s)).toBeUndefined();
});

test('provider command traffic leaves no token or raw provider payload in model input, replies or files', async () => {
  const s = await setup(); await s.open([ok('CLEAN')]);
  await s.accept('/fast on'); await s.accept('/usage'); await s.accept('Plain message.');
  await vi.waitFor(() => expect(s.finals).toContain('CLEAN'), wait);
  const everything = JSON.stringify([s.requests, s.presented, s.finals]);
  expect(everything).not.toMatch(/service_tier|access_token|refresh_token|Bearer /i);
  expect(JSON.stringify(s.requests.flatMap(r=>r.messages.filter((m:any)=>m.role==='user')))).not.toMatch(/\/fast|\/usage/);
  for (const file of new Set((await Promise.all([s.stateDir].map(listFiles))).flat())) { if ((await stat(file)).size > 5_000_000) continue; expect((await readFile(file)).includes('service_tier'), file).toBe(false); }
});

test('provider profile loads with the same explicit browser configuration as the browser profile', async () => {
  const s = await setup(); const { historyDir, inboxPath, runtimeMetadataPath, ...input } = s.config; const path = join(s.directory, 'instance.json');
  await writeFile(path, JSON.stringify(input), { mode: 0o600 });
  expect((await loadNativeConfig(path)).capabilityProfile).toBe('durable-provider-test');
  await writeFile(path, JSON.stringify({ ...input, principal: 'emma' }), { mode: 0o600 });
  await expect(loadNativeConfig(path)).rejects.toThrow(/principal/);
});
