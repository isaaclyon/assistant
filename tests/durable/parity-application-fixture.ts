import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import type { NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

// Browser domain services are replaced through the browserServices seam. Everything else is production.
export const cleanup: Array<() => Promise<unknown>> = [];
export async function setup(profile = 'durable-parity-test', existingDirectory?:string) {
  const directory = existingDirectory??await mkdtemp(join(tmpdir(), 'native-parity-app-')); if(!existingDirectory)cleanup.push(() => rm(directory, { recursive: true, force: true }));
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
  await mkdir(config.google!.gog!.home, { mode: 0o700, recursive:true }); await writeFile(config.google!.gog!.passwordFile, 'fictional-password', { mode: 0o600 });
  await writeFile(config.google!.gog!.binary, `#!${process.execPath}\nconsole.log('{}');\n`, { mode: 0o700 });

  const inputCalls: any[] = [], takeoverCalls: any[] = [];
  const behavior = { input: async (_o: any): Promise<any> => ({ status: 'submitted' }), takeover: async (_o: any): Promise<any> => ({ status: 'handed_back' }) };
  const services = {
    input: async (options: any) => { inputCalls.push(options); return behavior.input(options); },
    takeover: async (options: any) => { takeoverCalls.push(options); return behavior.takeover(options); },
    candidates: async () => ({ ok: true, candidates: [] }),
  };
  let hooks!: NativeTelegramHooks; let nextId = 100; const finals: string[] = [], presented: string[] = [], requests: any[] = []; const fatal:unknown[]=[];
  const raw = { start: async (h: NativeTelegramHooks) => { hooks = h; return 'ready' as const; }, stop: async () => {}, deliver: async (_t: unknown, text: string) => { finals.push(text); return ++nextId; }, present: async (_t: unknown, value: { text: string }) => { presented.push(value.text); return ++nextId; }, edit: async () => {}, answerCallback: async () => true };
  let app: Awaited<ReturnType<typeof createNativeApplication>> | undefined; cleanup.push(async () => app?.close());
  const open = async (responses: any[] = [], plainModel = false, extras: Partial<import('../../src/durable/application.js').NativeApplicationOptions> = {}, configureModels?: (models:ReturnType<typeof createModels>)=>void) => {
    const faux = fauxProvider({ ...(['durable-provider-test','durable-parity-test'].includes(profile) && !plainModel ? { provider: 'openai-codex', api: 'openai-codex-responses' } : {}), tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
    faux.setResponses(responses.map(response => (request: any) => { requests.push(structuredClone(request)); return typeof response === 'function' ? response(request) : response; }));
    const models = createModels(); models.setProvider(faux.provider); configureModels?.(models); const model = faux.getModel();
    app = await createNativeApplication(config, { provider: { models, provider: faux.provider, model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off', close: async () => {} }, transport: raw, onFatal: (error:unknown)=>{fatal.push(error);}, onTransportFailure: () => {}, browserServices: services, ...extras } as any);
    await app.start(); return app;
  };
  let updateId = 1;
  const accept = (text: string, chat: Record<string, unknown> = { id: 42, type: 'private' }, from = 42, fixedId?: number) => { const id = fixedId ?? updateId++; return hooks.accept({ update_id: id, message: { message_id: 1000 + id, date: 1700000000 + id, from: { id: from }, chat, text } } as any); };
  return { directory, config, open, accept, presented, finals, requests, fatal, inputCalls, takeoverCalls, behavior, stateDir, close: async () => { await app?.close(); app = undefined; }, app: () => app };
}

export function fictionalWebAuth(models:ReturnType<typeof createModels>) {
 const original=models.getModel.bind(models);
 models.getModel=(p,i)=>{const m=original(p,i);return m?{...m,baseUrl:'https://chatgpt.com/backend-api'}:undefined;};
 models.checkAuth=async()=>({type:'oauth'} as never);
 const token=`x.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fictional-account'}})).toString('base64url')}.x`;
 models.getAuth=async()=>({auth:{apiKey:token}});
}
