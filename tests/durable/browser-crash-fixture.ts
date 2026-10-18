import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import { runPrivateBrowserInput } from '../../src/private-browser-input.js';
import { runBrowserTakeover } from '../../src/browser-takeover.js';
import { assertUnprotected, paths, withSessionLock } from '../../.pi/skills/agent-browser/scripts/stock-chrome.mjs';
import type { NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

export const SECRET = 'synthetic-crash-secret-7c1d';
export type Tool = 'private_browser_input' | 'browser_takeover' | 'private_browser_login' | 'private_opentable_login';
export type Phase = 'gate' | 'after';
export const toolArgs: Record<Tool, Record<string, unknown>> = {
  private_browser_input: { session: 'crash-input', pageUrl: 'https://example.test/login', resumeUrl: 'https://example.test/', fields: [{ kind: 'password', selector: '#password' }], submitSelector: '#submit' },
  browser_takeover: { session: 'crash-takeover', resumeUrl: 'https://example.test/' },
  private_browser_login: { session: 'crash-login', pageUrl: 'https://example.test/login', resumeUrl: 'https://example.test/' },
  private_opentable_login: { session: 'crash-opentable' },
};
export const call = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: 'toolUse' });
export const done = (value: string) => fauxAssistantMessage(value);
export const toolText = (request: any) => { const m = request.messages.filter((x: any) => x.role === 'toolResult').at(-1); return typeof m.content === 'string' ? m.content : m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'); };
const lines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

/** Production native application with a stock-gate-writing fictional domain service in place of Chrome. */
export async function browserFixture(directory: string, options: { pause?: boolean; actualBlockedRecovery?:boolean } = {}) {
  const stateDir = join(directory, 'state'), workspaceCwd = join(directory, 'workspace'), vaultRoot = join(directory, 'vault');
  const agentDir = join(directory, 'agent'), configRoot = join(directory, 'browser-config'), runtimeDir = join(directory, 'browser-runtime'), dataDir = join(directory, 'browser-data');
  await Promise.all([stateDir, workspaceCwd, vaultRoot, agentDir, configRoot, runtimeDir, dataDir, join(directory, 'gog-home')].map(p => mkdir(p, { recursive: true, mode: 0o700 })));
  await writeFile(join(agentDir, 'telegram.json'), JSON.stringify({ profiles: { 'synthetic-profile': { botToken: '123:runtime', allowedUserId: 42 } } }), { mode: 0o600 });
  const binary = join(directory, 'fake-gog'), passwordFile = join(directory, 'password');
  if (!existsSync(binary)) { await writeFile(binary, `#!${process.execPath}\nconsole.log('{}');\n`, { mode: 0o700 }); await writeFile(passwordFile, 'fictional-password', { mode: 0o600 }); }
  const config = { version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40), resourceRoot: resolve(process.cwd()), workspaceCwd, stateDir, capabilityProfile: 'durable-browser-test', account: 'test', credentialPath: join(directory, 'unused-auth'), settingsPath: join(directory, 'unused-settings'), jobsRole: 'disabled', idleHours: 0,
    transport: { mode: 'broker', socketPath: join(directory, 'unused.sock'), botId: 123, allowedUserId: 42 }, historyDir: join(stateDir, 'durable'), inboxPath: join(stateDir, 'inbox.db'), runtimeMetadataPath: join(stateDir, 'runtime.json'),
    memory: { vaultRoot, gitAutocommit: false, legacySessionRoots: [], timeZone: 'UTC', recall: 'off', semantic: 'off' },
    google: { account: 'owner@example.com', gog: { binary, passwordFile, home: join(directory, 'gog-home') }, calendarTargets: { account: 'owner@example.com', personal: 'personal-id', thingsToDo: 'things-id' } },
    browser: { agentDir, telegramProfile: 'synthetic-profile', credentialScope: 'synthetic-scope', configRoot, runtimeDir, dataDir, endpoints: { bindAddress: '10.20.30.2', inputOrigin: 'https://assistant.synthetic.ts.net:8446', takeoverOrigin: 'https://assistant.synthetic.ts.net:8447' } } } as unknown as NativeConfig;
  const mark = (phase: string) => {
    let control: { phase?: Phase } = {};
    try { control = JSON.parse(readFileSync(join(directory, 'pause.json'), 'utf8')); } catch { return undefined; }
    if (!options.pause || control.phase !== phase) return undefined;
    writeFileSync(join(directory, 'paused.json'), JSON.stringify({ pid: process.pid, phase }), { flag: 'wx' });
    process.send?.({ type: 'paused', phase });
    return new Promise<never>(() => { setInterval(() => {}, 1000); });
  };
  const service = (kind: string) => async (opts: any) => {
    const session = opts.request.session as string;
    appendFileSync(join(directory, 'service-calls.jsonl'), JSON.stringify({ kind, session, chatId: opts.chatId }) + '\n');
    if(options.actualBlockedRecovery)return kind==='input'?runPrivateBrowserInput(opts):runBrowserTakeover(opts);
    return withSessionLock(session, async () => {
      try { await assertUnprotected(session); } catch { return { status: 'browser_blocked' }; }
      // Same file and exclusive-create semantics as the stock input and takeover helpers.
      await writeFile(paths(session).protectedPath, JSON.stringify({ version: 1, launchId: 'synthetic-launch', requestId: randomUUID(), purpose: kind }), { mode: 0o600, flag: 'wx' });
      await mark('gate');
      // External synthetic submission effect; the secret exists only outside the durable state directory.
      appendFileSync(join(directory, 'effects.jsonl'), JSON.stringify({ kind, session, secret: SECRET }) + '\n');
      await mark('after');
      return { status: 'submitted', password: SECRET };
    });
  };
  const browserServices = { input: service('input'), takeover: service('takeover'), candidates: async () => ({ ok: true, candidates: [] }) };
  let hooks!: NativeTelegramHooks; let nextMessage = 100; let updateId = 1;
  const finals: string[] = [], requests: any[] = [], fatal: unknown[] = [];
  const raw = { start: async (value: NativeTelegramHooks) => { hooks = value; return 'ready' as const; }, stop: async () => {}, deliver: async (_t: unknown, value: string) => { finals.push(value); return ++nextMessage; }, present: async () => ++nextMessage, edit: async () => {}, answerCallback: async () => true };
  let app: Awaited<ReturnType<typeof createNativeApplication>> | undefined;
  const open = async (responses: any[] = []) => {
    const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
    faux.setResponses(responses.map(response => (request: any) => { requests.push(structuredClone(request)); return typeof response === 'function' ? response(request) : response; }));
    const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
    app = await createNativeApplication(config, { provider: { models, provider: faux.provider, model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off', close: async () => {} }, transport: raw, onFatal: (e: unknown) => { fatal.push(e); }, onTransportFailure: () => {}, browserServices } as any);
    await app.start(); return app;
  };
  const accept = (text: string, id = updateId++) => hooks.accept({ update_id: id, message: { message_id: 1000 + id, date: 1700000000 + id, from: { id: 42 }, chat: { id: 42, type: 'private' }, text } } as any);
  return { directory, config, stateDir, open, accept, finals, requests, fatal, app: () => app,
    pauseAt: (phase: Phase) => writeFile(join(directory, 'pause.json'), JSON.stringify({ phase })),
    serviceCalls: (): Array<{ kind: string; session: string; chatId: number }> => lines(join(directory, 'service-calls.jsonl')),
    effects: (): Array<{ kind: string; session: string }> => lines(join(directory, 'effects.jsonl')),
    gateFile: (session: string) => join(runtimeDir, 'pi-agent-browser', 'test', session, 'protected-input.json'),
    assertUnprotected,
    close: async () => { try { await app?.close(); } finally { app = undefined; } } };
}
export type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;
