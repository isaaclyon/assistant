import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import { openPlacesStore } from '../../src/places-store.js';
import { PlacesService } from '../../src/places-service.js';
import type { NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';
import type { Presentation } from '../../src/durable/telegram-ui.js';

export const ownerKey = 'instance:test:principal:isaac';
export const account = 'crash@example.test';
export const personalCalendar = 'crash-personal-calendar';
export const thingsCalendar = 'crash-things-calendar';
export const seededEventId = 'seededevent1';
export const seededEtag = '"seed-1"';
export const createArgs = { operation: 'calendar_create', operation_key: 'crash-create-1', event: { summary: 'Crash Event', start: { dateTime: '2030-01-02T10:00:00-05:00', timeZone: 'America/New_York' }, end: { dateTime: '2030-01-02T11:00:00-05:00', timeZone: 'America/New_York' } } };
export const updateArgs = { operation: 'calendar_update', event_id: seededEventId, if_etag: seededEtag, patch: { summary: 'Updated Crash Event' } };
export const deleteRequestArgs = { operation: 'calendar_request_delete', event_id: seededEventId, if_etag: seededEtag };
export type Json = Record<string, any>;
export interface GogCall { method: string; id?: string; write: boolean; readonly: boolean }

/** Fake gog: persists a real remote calendar in remote.json, logs every invocation, and for a
 * configured write method pauses (marker file, then sleeps) before or after persisting the effect. */
function gogScript(directory: string) {
  return `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const dir=${JSON.stringify(directory)};const args=process.argv.slice(2);const f=n=>path.join(dir,n);
const parent=process.ppid;
const load=()=>{try{return JSON.parse(fs.readFileSync(f('remote.json'),'utf8'));}catch{return {seq:100,events:{}};}};
const save=s=>{fs.writeFileSync(f('remote.tmp'),JSON.stringify(s));fs.renameSync(f('remote.tmp'),f('remote.json'));};
const arg=name=>{const hit=args.find(a=>a.startsWith('--'+name+'='));return hit?JSON.parse(hit.slice(name.length+3)):undefined;};
const out=v=>{process.stdout.write(JSON.stringify(v));process.exit(0);};
const fail=code=>{process.stderr.write('Error '+code);process.exit(1);};
const pause=(method,phase)=>{
 let control;try{control=JSON.parse(fs.readFileSync(f('pause.json'),'utf8'));}catch{return;}
 if(control.method!==method||control.phase!==phase)return;
 try{fs.writeFileSync(f('paused.json'),JSON.stringify({pid:process.pid,method,phase}),{flag:'wx'});}catch{return;}
 const started=Date.now();
 setInterval(()=>{if(process.ppid!==parent||Date.now()-started>120000)process.exit(7);},100);
 return true;
};
const apiAt=args.indexOf('api');
if(apiAt<0)out({accounts:[{email:${JSON.stringify(account)},services:['calendar'],scopes:['https://www.googleapis.com/auth/calendar']}]});
const method=String(args[apiAt+4]).replace('calendar.','');const params=arg('params')||{};const body=arg('body');
const write=['events.insert','events.patch','events.delete'].includes(method);
const id=method==='events.insert'?body.id:params.eventId;
fs.appendFileSync(f('gog-calls.jsonl'),JSON.stringify({method,id,write,readonly:args.includes('--readonly')})+'\\n');
const key=i=>params.calendarId+'/'+i;
if(method==='calendarList.get')out({id:params.calendarId,accessRole:'owner'});
const state=load();
if(method==='events.get'){const e=state.events[key(id)];if(!e)fail(404);out(e);}
if(!write)fail(400);
const waiting=pause(method,'before');
const effect=()=>{
 state.seq++;
 if(method==='events.insert'){if(state.events[key(id)])fail(409);state.events[key(id)]={...body,etag:'"e'+state.seq+'"',status:'confirmed'};}
 else{const e=state.events[key(id)];if(!e)fail(404);
  if(method==='events.patch')state.events[key(id)]={...e,...body,etag:'"e'+state.seq+'"'};
  else state.events[key(id)]={...e,status:'cancelled',etag:'"e'+state.seq+'"'};}
 save(state);fs.appendFileSync(f('gog-effects.jsonl'),JSON.stringify({method,id})+'\\n');
};
if(!waiting){effect();const after=pause(method,'after');if(!after)out(method==='events.delete'?{}:state.events[key(id)]);}
`;
}

export interface FixtureOptions { seed?: boolean }
const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
export const toolResult = (request: any) => request.messages.filter((m: any) => m.role === 'toolResult').at(-1);
export const toolText = (request: any) => text(toolResult(request));
export const call = (name: string, args: unknown) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: 'toolUse' });
export const done = (value: string) => fauxAssistantMessage(value);

/** Real native application (DurableHost, production native modules, canonical places SQLite) over a fake gog. */
export async function mutationsFixture(directory: string, options: FixtureOptions = {}) {
  const stateDir = join(directory, 'state'), workspaceCwd = join(directory, 'workspace'), vaultRoot = join(directory, 'vault'), home = join(directory, 'gog-home');
  for (const path of [stateDir, workspaceCwd, vaultRoot, home]) await mkdir(path, { recursive: true, mode: 0o700 });
  const binary = join(directory, 'fake-gog'), passwordFile = join(directory, 'gog-password');
  if (!existsSync(binary)) { await writeFile(binary, gogScript(directory), { mode: 0o700 }); await chmod(binary, 0o700); await writeFile(passwordFile, 'fictional-password', { mode: 0o600 }); await chmod(passwordFile, 0o600); }
  const config = { version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40), resourceRoot: resolve(process.cwd()), workspaceCwd, stateDir, capabilityProfile: 'durable-mutations-test', account: 'test', credentialPath: join(directory, 'unused-auth'), settingsPath: join(directory, 'unused-settings'), jobsRole: 'disabled', idleHours: 0,
    transport: { mode: 'broker', socketPath: join(directory, 'unused.sock'), botId: 123, allowedUserId: 42 }, historyDir: join(stateDir, 'durable'), inboxPath: join(stateDir, 'inbox.db'), runtimeMetadataPath: join(stateDir, 'runtime.json'),
    memory: { vaultRoot, gitAutocommit: false, legacySessionRoots: [], timeZone: 'UTC', recall: 'off', semantic: 'off' },
    google: { account, gog: { binary, passwordFile, home }, calendarTargets: { account, personal: personalCalendar, thingsToDo: thingsCalendar } } } as unknown as NativeConfig;
  const domain = () => { const store = openPlacesStore(join(stateDir, 'places.db')); return { store, service: new PlacesService(store, { ownerKey }) }; };
  const places = () => { const d = domain(); try { return d.service.listCategories().flatMap(c => d.service.listRanking(c.id).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name, categoryId: c.id }))); } finally { d.store.close(); } };
  if (options.seed !== false) {
    await writeFile(join(directory, 'remote.json'), JSON.stringify({ seq: 100, events: { [`${personalCalendar}/${seededEventId}`]: { id: seededEventId, etag: seededEtag, status: 'confirmed', summary: 'Seeded Event', start: { dateTime: '2030-02-01T10:00:00-05:00', timeZone: 'America/New_York' }, end: { dateTime: '2030-02-01T11:00:00-05:00', timeZone: 'America/New_York' } } } }));
    const d = domain();
    try { const categoryId = d.service.listCategories()[0]!.id; let step: any = d.service.start({ name: 'Crash Cafe', categoryId, sentiment: 'liked' }); while (step.kind === 'compare') step = d.service.answer({ insertionId: step.insertionId, revision: step.revision, existingPlaceId: step.existingPlace.id, winner: 'existing' }); } finally { d.store.close(); }
  }
  let hooks!: NativeTelegramHooks; let nextMessage = 100; let updateId = 1;
  const presentations: Array<{ messageId: number; value: Presentation }> = [], finals: string[] = [], requests: any[] = [], toasts: string[] = [], fatal: unknown[] = [];
  const raw = { start: async (value: NativeTelegramHooks) => { hooks = value; return 'ready' as const; }, stop: async () => {}, deliver: async (_t: unknown, value: string) => { finals.push(value); return ++nextMessage; },
    present: async (_t: unknown, value: Presentation) => { const messageId = ++nextMessage; presentations.push({ messageId, value }); return messageId; }, edit: async () => {}, answerCallback: async (_id: string, value: string) => { toasts.push(value); return true; } };
  let app: Awaited<ReturnType<typeof createNativeApplication>> | undefined;
  const open = async (responses: any[] = []) => {
    const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
    faux.setResponses(responses.map(response => (request: any) => { requests.push(structuredClone(request)); return typeof response === 'function' ? response(request) : response; }));
    const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
    app = await createNativeApplication(config, { provider: { models, provider: faux.provider, model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off', close: async () => {} }, transport: raw, onFatal: (e: unknown) => { fatal.push(e); }, onTransportFailure: () => {} } as any);
    await app.start(); return app;
  };
  const accept = (value: string, id = updateId++) => hooks.accept({ update_id: id, message: { message_id: 1000 + id, date: 1700000000 + id, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: value } } as any);
  const callback = (messageId: number, data: string, id = updateId++) => hooks.accept({ update_id: id, callback_query: { id: `cb${id}`, data, from: { id: 42 }, message: { message_id: messageId, chat: { id: 42, type: 'private' } } } } as any);
  const latest = () => presentations.at(-1)!;
  const button = (label: RegExp, view = latest()) => { const match = view.value.buttons?.flat().find(b => label.test(b.text)); if (!match || !('callback' in match)) throw new Error(`No button ${label}: ${JSON.stringify(view)}`); return (match as { callback: string }).callback; };
  const readLines = (name: string) => existsSync(join(directory, name)) ? readFileSync(join(directory, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { directory, config, open, accept, callback, latest, button, presentations, finals, requests, toasts, fatal, places, app: () => app,
    /** Control file consumed by fake-gog: pause at the Nth... first matching write. */
    pauseAt: (method: 'events.insert' | 'events.patch' | 'events.delete', phase: 'before' | 'after') => writeFile(join(directory, 'pause.json'), JSON.stringify({ method, phase })),
    remote: async (): Promise<Json> => JSON.parse(await readFile(join(directory, 'remote.json'), 'utf8')),
    calls: (): GogCall[] => readLines('gog-calls.jsonl'), effects: (): Array<{ method: string; id?: string }> => readLines('gog-effects.jsonl'),
    paused: (): { pid: number; method: string; phase: string } | undefined => existsSync(join(directory, 'paused.json')) ? JSON.parse(readFileSync(join(directory, 'paused.json'), 'utf8')) : undefined,
    close: async () => { try { await app?.close(); } finally { app = undefined; } } };
}
export type MutationsFixture = Awaited<ReturnType<typeof mutationsFixture>>;
