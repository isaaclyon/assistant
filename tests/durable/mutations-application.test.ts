import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import { loadNativeConfig, type NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';
import type { Presentation } from '../../src/durable/telegram-ui.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const initialEvent={id:'event1',etag:'v1',summary:'Synthetic event',start:{date:'2026-11-01'},end:{date:'2026-11-02'},organizer:{self:true}};
async function setup() {
 const directory=await mkdtemp(join(tmpdir(),'native-mutations-app-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const stateDir=join(directory,'state'),workspaceCwd=join(directory,'workspace'),vaultRoot=join(directory,'vault');
 await Promise.all([stateDir,workspaceCwd,vaultRoot].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 const config:NativeConfig={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:'a'.repeat(40),resourceRoot:resolve(import.meta.dirname,'../..'),workspaceCwd,stateDir,capabilityProfile:'durable-mutations-test',account:'test',credentialPath:join(directory,'unused-auth'),settingsPath:join(directory,'unused-settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(directory,'unused.sock'),botId:123,allowedUserId:42},historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json'),memory:{vaultRoot,gitAutocommit:false,legacySessionRoots:[],timeZone:'UTC',recall:'off',semantic:'off'},google:{account:'owner@example.com',gog:{binary:join(directory,'fake-gog'),passwordFile:join(directory,'password'),home:join(directory,'gog-home')},calendarTargets:{account:'owner@example.com',personal:'personal-id',thingsToDo:'things-id'}}};
 await mkdir(config.google!.gog!.home,{mode:0o700});await writeFile(config.google!.gog!.passwordFile,'fictional-password',{mode:0o600});
 const remotePath=join(directory,'remote.json'),callsPath=join(directory,'calls.jsonl');await writeFile(remotePath,JSON.stringify({event1:initialEvent}));
 // Exercise the default production subprocess transport and the operation-owned API argv.
 await writeFile(config.google!.gog!.binary,`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),path=${JSON.stringify(remotePath)};
const events=JSON.parse(fs.readFileSync(path,'utf8'));
const method=args.find(x=>x.startsWith('calendar.'));
const params=JSON.parse((args.find(x=>x.startsWith('--params='))||'--params={}').slice(9));
const body=JSON.parse((args.find(x=>x.startsWith('--body='))||'--body={}').slice(7));
if(method==='calendar.calendarList.get'&&fs.existsSync(${JSON.stringify(join(directory,'permission-gate'))})){
 fs.writeFileSync(${JSON.stringify(join(directory,'permission-waiting'))},'waiting');
 while(fs.existsSync(${JSON.stringify(join(directory,'permission-gate'))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,method,params})+'\\n');
let out;
if(method==='calendar.calendarList.get')out={id:params.calendarId,accessRole:'owner'};
else if(method==='calendar.events.get'){out=events[params.eventId];if(!out){console.error('404 not found');process.exit(1);}}
else if(method==='calendar.events.insert'){if(events[body.id]){console.error('409 conflict');process.exit(1);}out={...body,etag:'created',organizer:{self:true}};events[out.id]=out;}
else if(method==='calendar.events.patch'){out={...events[params.eventId],...body,etag:'v2'};events[params.eventId]=out;}
else if(method==='calendar.events.delete'){out={...events[params.eventId],status:'cancelled',etag:'deleted'};events[params.eventId]=out;}
else if(args.includes('gmail'))out={threads:[{id:'thread1',subject:'Synthetic mail'}]};
else out={calendars:[]};
fs.writeFileSync(path,JSON.stringify(events));console.log(JSON.stringify(out));
`,{mode:0o700});
 let hooks!:NativeTelegramHooks;let nextId=100;const finals:string[]=[],requests:any[]=[],presentations:Array<{messageId:number;value:Presentation}>=[],toasts:string[]=[];const fatal=vi.fn();let lostReceipt=false,stopGate:Promise<unknown>|undefined;
 const raw={start:async(h:NativeTelegramHooks)=>{hooks=h;return 'ready' as const;},stop:async()=>{await stopGate;},deliver:async(_t:unknown,text:string)=>{finals.push(text);return ++nextId;},present:async(_t:unknown,value:Presentation)=>{const messageId=++nextId;presentations.push({messageId,value});if(lostReceipt)throw new Error('synthetic receipt lost');return messageId;},edit:async()=>{},answerCallback:async(_id:string,text:string)=>{toasts.push(text);return true;}};
 let app:Awaited<ReturnType<typeof createNativeApplication>>|undefined;cleanup.push(async()=>app?.close());
 const open=async(responses:any[]=[])=>{const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});faux.setResponses(responses.map(response=>(request:any)=>{requests.push(structuredClone(request));return typeof response==='function'?response(request):response;}));const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();app=await createNativeApplication(config,{provider:{models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',close:async()=>{}},transport:raw,onFatal:fatal,onTransportFailure:()=>{}});await app.start();return app;};
 let updateId=1;
 const accept=(text:string)=>{const id=updateId++;return hooks.accept({update_id:id,message:{message_id:1000+id,date:1700000000+id,from:{id:42},chat:{id:42,type:'private'},text}});};
 const callback=(messageId:number,data:string,extra:Record<string,unknown>={},id=updateId++)=>hooks.accept({update_id:id,callback_query:{id:`cb${id}`,data,from:{id:42},message:{message_id:messageId,chat:{id:42,type:'private'}},...extra}});
 const latest=()=>presentations.at(-1)!;
 const button=(label:RegExp,view=latest())=>{const found=view.value.buttons?.flat().find(b=>label.test(b.text));if(!found||!('callback'in found))throw new Error(`Missing ${label}: ${JSON.stringify(view)}`);return found.callback;};
 const calls=async()=>{try{return (await readFile(callsPath,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return [];}};
 return {directory,config,open,accept,callback,latest,button,finals,requests,presentations,toasts,fatal,calls,remote:async()=>JSON.parse(await readFile(remotePath,'utf8')),setRemote:async(value:unknown)=>writeFile(remotePath,JSON.stringify(value)),lostReceipt:(v:boolean)=>{lostReceipt=v;},waitStopFor:(work:Promise<unknown>)=>{stopGate=work;},close:async()=>{await app?.close();app=undefined;}};
}
const call=(args:unknown,id?:string)=>fauxAssistantMessage({...fauxToolCall('google_workspace',args as never),...(id?{id}:{})},{stopReason:'toolUse'});
const resultText=(r:any)=>{const m=r.messages.filter((m:any)=>m.role==='toolResult').at(-1);return typeof m.content==='string'?m.content:m.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');};
const create={operation:'calendar_create',operation_key:'synthetic-request-1',event:{summary:'Synthetic create',start:{date:'2026-11-03'},end:{date:'2026-11-04'}}};
const preview={operation:'calendar_request_delete',event_id:'event1',if_etag:'v1'};
async function waitIdle(app:Awaited<ReturnType<typeof createNativeApplication>>) {await vi.waitFor(async()=>expect((await app.controls.status()).busy).toBe(false),{timeout:6000});}

test('guarded profile composes reads, Calendar create/update and places with the real Google subprocess',async()=>{
 const s=await setup();await s.open([
  call(create),(r:any)=>{expect(resultText(r)).toContain('Synthetic create');return call({...create});},
  (r:any)=>{expect(resultText(r)).toContain('Synthetic create');return call({operation:'calendar_update',event_id:'event1',if_etag:'v1',patch:{summary:'Edited event'}});},
  (r:any)=>{expect(resultText(r)).toContain('Edited event');return call({operation:'gmail_search',query:'in:inbox'});},
  (r:any)=>{expect(resultText(r)).toContain('Synthetic mail');return fauxAssistantMessage('CHANGES_VERIFIED');},
 ]);await s.accept('Make synthetic Calendar changes.');await vi.waitFor(()=>expect(s.finals).toContain('CHANGES_VERIFIED'),{timeout:8000});
 const calls=await s.calls(),writes=calls.filter(c=>['calendar.events.insert','calendar.events.patch','calendar.events.delete'].includes(c.method));expect(writes.map(c=>c.method)).toEqual(['calendar.events.insert','calendar.events.patch']);
 for(const c of writes){expect(c.args).toEqual(expect.arrayContaining(['--no-input','--gmail-no-send','--force','--allow-write']));expect(c.params.sendUpdates).toBe('none');}
 expect((await s.remote()).event1).toMatchObject({summary:'Edited event',start:initialEvent.start,end:initialEvent.end});
 const names=s.requests[0].messages.flatMap((m:any)=>m.toolsAdded??[]).map((t:any)=>t.name);expect(names).toContain('rank_places');expect(names.filter((x:string)=>x==='google_workspace')).toHaveLength(1);expect(names).not.toContain('google_calendar_write');expect(s.fatal).not.toHaveBeenCalled();
});

test('Calendar deletion preview survives restart, rejects other origins and consumes exact callback once',async()=>{
 const s=await setup();const app=await s.open([call(preview),fauxAssistantMessage('PREVIEW_READY')]);await s.accept('Delete the synthetic event.');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1),{timeout:6000});await waitIdle(app);
 const p=s.latest(),confirm=s.button(/^confirm/i,p);expect(p.value.text).toContain('Synthetic event');expect((await s.calls()).some(c=>c.method==='calendar.events.delete')).toBe(false);
 // Tool/model output can describe the pending request but must never carry the approval handle.
 expect(JSON.stringify(s.requests.slice(1))).not.toContain(confirm);expect(JSON.stringify(s.requests.slice(1))).not.toContain(confirm.split(':')[1]);
 await s.close();await s.open();await s.callback(p.messageId+1,confirm);await s.callback(p.messageId,confirm,{from:{id:99}});await s.callback(p.messageId,confirm,{message:{message_id:p.messageId,chat:{id:99,type:'private'}}});
 expect((await s.calls()).some(c=>c.method==='calendar.events.delete')).toBe(false);
 await Promise.all([s.callback(p.messageId,confirm,{},700),s.callback(p.messageId,confirm,{},700)]);await s.callback(p.messageId,confirm,{},701);
 expect((await s.calls()).filter(c=>c.method==='calendar.events.delete')).toHaveLength(1);expect((await s.remote()).event1.status).toBe('cancelled');expect(s.requests).toHaveLength(2);expect(s.fatal).not.toHaveBeenCalled();
});

test.each(['/new','/reload'])('%s invalidates pending Calendar confirmation',async command=>{
 const s=await setup();const app=await s.open([call(preview),fauxAssistantMessage('PENDING')]);await s.accept('Preview synthetic deletion.');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1),{timeout:6000});await waitIdle(app);const p=s.latest(),key=s.button(/^confirm/i,p);
 await s.accept(command);await s.callback(p.messageId,key);expect((await s.calls()).filter(c=>c.method==='calendar.events.delete')).toHaveLength(0);expect((await s.remote()).event1.status).toBeUndefined();
});

test('Calendar version changes and lost preview acknowledgements cannot authorize deletion',async()=>{
 const s=await setup();const app=await s.open([call(preview),fauxAssistantMessage('PENDING')]);await s.accept('Preview synthetic deletion.');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1),{timeout:6000});await waitIdle(app);const p=s.latest(),key=s.button(/^confirm/i,p);
 await s.setRemote({event1:{...initialEvent,etag:'external-version',summary:'Externally edited'}});await s.callback(p.messageId,key);expect((await s.calls()).filter(c=>c.method==='calendar.events.delete')).toHaveLength(0);
 await s.close();await s.setRemote({event1:initialEvent});s.lostReceipt(true);const reopened=await s.open([call(preview),fauxAssistantMessage('UNACKNOWLEDGED')]);await s.accept('Preview again.');await vi.waitFor(()=>expect(s.presentations.length).toBeGreaterThan(1),{timeout:6000});await waitIdle(reopened);s.lostReceipt(false);const unknown=s.latest();await s.callback(unknown.messageId,s.button(/^confirm/i,unknown));expect((await s.calls()).filter(c=>c.method==='calendar.events.delete')).toHaveLength(0);
});

test('guarded profile requires explicit scoped configuration and rejects changed recovery targets',async()=>{
 const s=await setup();const {historyDir,inboxPath,runtimeMetadataPath,...input}=s.config;const path=join(s.directory,'instance.json');const load=async(value:unknown)=>{await writeFile(path,JSON.stringify(value),{mode:0o600});return loadNativeConfig(path);};
 expect((await load(input)).capabilityProfile).toBe('durable-mutations-test');for(const principal of ['emma','household','engineering'])await expect(load({...input,principal})).rejects.toThrow(/principal/);await expect(load({...input,google:undefined})).rejects.toThrow();
 await s.open([fauxAssistantMessage('SAVED')]);await s.accept('Hello');await vi.waitFor(()=>expect(s.finals).toContain('SAVED'));await s.close();s.config.google!.calendarTargets!.personal='another-id';await expect(s.open()).rejects.toThrow(/compatib|registry|changed/i);
});

test('reload invalidates a claimed Calendar deletion waiting for its final permission check',async()=>{
 const s=await setup();const app=await s.open([call(preview),fauxAssistantMessage('PENDING')]);await s.accept('Preview deletion.');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1));await waitIdle(app);
 const p=s.latest(),gate=join(s.directory,'permission-gate');await writeFile(gate,'hold');
 const callback=s.callback(p.messageId,s.button(/^confirm/i,p));
 try {
  await vi.waitFor(async()=>expect(await readFile(join(s.directory,'permission-waiting'),'utf8')).toBe('waiting'),{timeout:6000});
  await s.accept('/reload');
 } finally {await rm(gate,{force:true});}
 await callback;
 expect((await s.calls()).filter(c=>c.method==='calendar.events.delete')).toHaveLength(0);
 expect((await s.remote()).event1).toEqual(initialEvent);
});

test('application shutdown aborts a Calendar transport before closing the Harness',async()=>{
 const s=await setup();const app=await s.open([call(preview),fauxAssistantMessage('PENDING')]);await s.accept('Preview deletion.');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1));await waitIdle(app);
 const p=s.latest(),gate=join(s.directory,'permission-gate');await writeFile(gate,'hold');
 const callback=s.callback(p.messageId,s.button(/^confirm/i,p));
 await vi.waitFor(async()=>expect(await readFile(join(s.directory,'permission-waiting'),'utf8')).toBe('waiting'),{timeout:6000});
 s.waitStopFor(callback); // Ordinary polling shutdown drains its active update handler.
 const closeHarness=vi.spyOn(app.host.runtime.harness,'close');let closed=false;
 const closing=s.close().then(()=>{closed=true;});
 try {await vi.waitFor(()=>expect(closed).toBe(true),{timeout:6000});} finally {await rm(gate,{force:true});}
 await callback;await closing;
 expect(closeHarness).toHaveBeenCalledTimes(1);expect((await s.calls()).filter(c=>c.method==='calendar.events.delete')).toHaveLength(0);
 expect((await s.remote()).event1).toEqual(initialEvent);expect(s.fatal).not.toHaveBeenCalled();
});

test('reused provider call IDs still admit distinct Calendar requests through the actual Harness',async()=>{
 const s=await setup(),update={operation:'calendar_update',event_id:'event1',if_etag:'v1',patch:{summary:'Requested edit'}};
 await s.open([call(update,'call_0'),fauxAssistantMessage('FIRST'),call(update,'call_0'),fauxAssistantMessage('SECOND')]);
 await s.accept('Edit this event');await vi.waitFor(()=>expect(s.finals).toContain('FIRST'),{timeout:6000});
 await s.setRemote({event1:initialEvent});
 await s.accept('It reverted; make that edit again');await vi.waitFor(()=>expect(s.finals).toContain('SECOND'),{timeout:6000});
 expect((await s.calls()).filter(c=>c.method==='calendar.events.patch')).toHaveLength(2);
 expect((await s.remote()).event1.summary).toBe('Requested edit');expect(s.fatal).not.toHaveBeenCalled();
});
