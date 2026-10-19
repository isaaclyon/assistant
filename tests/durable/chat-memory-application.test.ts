import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { watchEvents } from '@earendil-works/pi-durable';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import { Bindings, context } from '../../src/durable/ingress.js';
import { MemoryDrafts } from '../../src/durable/memory.js';
import type { NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(){
 const directory=await mkdtemp(join(tmpdir(),'c3-application-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const resourceRoot=resolve(import.meta.dirname,'../..'),stateDir=join(directory,'state'),workspaceCwd=join(directory,'workspace'),vaultRoot=join(directory,'vault');
 await Promise.all([stateDir,workspaceCwd,vaultRoot].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 const config:NativeConfig={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:'a'.repeat(40),resourceRoot,workspaceCwd,stateDir,capabilityProfile:'durable-chat-memory-test',account:'test',credentialPath:join(directory,'unused-auth'),settingsPath:join(directory,'unused-settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(directory,'unused.sock'),botId:123,allowedUserId:42},historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json'),memory:{vaultRoot,gitAutocommit:false,legacySessionRoots:[],timeZone:'UTC',recall:'off',semantic:'off'}};
 let hooks!:NativeTelegramHooks;
 const finals:string[]=[],presentations:Array<{text:string;buttons?:Array<Array<{callback?:string}>>}>=[];
 const preview=vi.fn(async()=>{}),restart=vi.fn(),fatal=vi.fn();
 let beforeFinal:(()=>Promise<void>)|undefined;
 const raw={start:async(value:NativeTelegramHooks)=>{hooks=value;return 'ready' as const;},stop:async()=>{},deliver:async(_target:unknown,text:string)=>{await beforeFinal?.();finals.push(text);return 100+finals.length;},present:async(_target:unknown,presentation:any)=>{presentations.push(presentation);return 200+presentations.length;},edit:async(_target:unknown,_id:number,presentation:any)=>{presentations.push(presentation);},preview,answerCallback:async()=>true};
 const requests:any[]=[];
 function provider(responses:any[]){
  const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});
  faux.setResponses(responses.map(response=>(request:any)=>{requests.push(structuredClone(request));return typeof response==='function'?response(request):response;}));
  const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
  return {models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off' as const,close(){}};
 }
 const event=(id:number,text:string)=>({update_id:id,message:{message_id:1000+id,date:1700000000+id,from:{id:42},chat:{id:42,type:'private'},text}});
 const callback=(id:number,messageId:number,data:string,actor=42)=>({update_id:id,callback_query:{id:`callback-${id}`,from:{id:actor},message:{message_id:messageId,chat:{id:42,type:'private'}},data}});
 let app:Awaited<ReturnType<typeof createNativeApplication>>|undefined;
 async function open(responses:any[]=[]){app=await createNativeApplication(config,{provider:provider(responses),transport:raw,requestRestart:restart,onFatal:fatal,onTransportFailure:()=>{}});await app.start();return app;}
 async function close(){await app?.close();app=undefined;}
 cleanup.push(close);
 return {directory,config,finals,presentations,preview,restart,fatal,requests,event,callback,open,close,onFinal:(fn:()=>Promise<void>)=>{beforeFinal=fn;},hooks:()=>hooks,app:()=>app!};
}
const tool=(args:unknown)=>fauxAssistantMessage(fauxToolCall('assistant_memory',args as never),{stopReason:'toolUse'});
const lastDetails=(request:any)=>{const result=request.messages.filter((message:any)=>message.role==='toolResult').at(-1);return JSON.parse(result.content.find((block:any)=>block.type==='text').text);};

 test('real selected registry saves a draft once, adds hidden dates, and resolves native citations after reopen/rebuild',async()=>{
 const s=await setup();
 let token='';
 const app=await s.open([
  tool({action:'create',draft:{type:'reference',title:'Synthetic zebra',body:'The zebra fixture is blue.'}}),
  (request:any)=>{const details=lastDetails(request);expect(details.status).toBe('review_required');token=details.result.draftToken;return tool({action:'create',draftToken:token});},
  (request:any)=>{expect(lastDetails(request)).toMatchObject({ok:true,status:'saved'});return fauxAssistantMessage('SAVED_ZEBRA');},
  tool({action:'create',draftToken:''}),
 ]);
 await s.hooks().accept(s.event(1,'Remember the synthetic zebra fixture tomorrow.'));
 await vi.waitFor(()=>expect(s.finals).toContain('SAVED_ZEBRA'),{timeout:4000});
 expect(s.requests[0].messages.flatMap((message:any)=>message.toolsAdded??[]).map((item:any)=>item.name).sort()).toEqual(['assistant_memory','assistant_memory_search','assistant_session_search','search_index','session_context']);
 expect(JSON.stringify(s.requests[0])).toContain('2023-11-15');
 const files=await readdir(join(s.config.memory!.vaultRoot,'references'));expect(files.filter(name=>name.endsWith('.md'))).toHaveLength(1);
 const body=await readFile(join(s.config.memory!.vaultRoot,'references',files[0]!),'utf8');expect(body).toContain('The zebra fixture is blue.');
 const found=await app.search!.sessionSearch({query:'zebra'});expect(found.ok).toBe(true);
 const results=(found.result as any).results;expect(results.length).toBeGreaterThan(0);
 const citation=results.find((item:any)=>item.role==='user');expect(citation.sessionId).toMatch(/^durable\.v1\./);
 const evidence=await app.search!.sessionContext({sessionId:citation.sessionId,entryId:citation.entryId});expect(evidence.ok).toBe(true);expect(JSON.stringify(evidence)).not.toContain('Date context');
 const {createMarkdownMemoryStore}=await import('../../.pi/skills/personal-memory/scripts/store.mjs');
 await createMarkdownMemoryStore({root:s.config.memory!.vaultRoot,principal:'isaac',memoryView:'owner-and-household'}).add({type:'reference',title:'Citation fixture',body:`A sourced fact.[^source]\n\n[^source]: Pi session \`${citation.sessionId}\`, entry \`${citation.entryId}\`, \`${citation.timestamp}\`.`});
 expect(await app.lintMemory()).toMatchObject({valid:true});
 await s.close();
 const next=await s.open([
  tool({action:'create',draftToken:token}),
  (request:any)=>{expect(lastDetails(request)).toMatchObject({ok:true,status:'saved'});return fauxAssistantMessage('JOINED_ZEBRA');},
 ]);
 await s.hooks().accept(s.event(2,'Commit that same draft again.'));
 await vi.waitFor(()=>expect(s.finals).toContain('JOINED_ZEBRA'),{timeout:4000});
 expect((await readdir(join(s.config.memory!.vaultRoot,'references'))).filter(name=>name.endsWith('.md'))).toHaveLength(2);
 await next.search!.indexOperation({operation:'rebuild',corpus:'session'});
 expect((await next.search!.sessionContext({sessionId:citation.sessionId,entryId:citation.entryId})).ok).toBe(true);
 expect(s.fatal).not.toHaveBeenCalled();
});

 test('slash commands and buttons use durable choices, reload expires drafts, and restart waits for offset acknowledgement',async()=>{
 const s=await setup();const app=await s.open([tool({action:'create',draft:{type:'list',title:'Synthetic list',body:'one'}}),fauxAssistantMessage('DRAFT_READY'),fauxAssistantMessage('AFTER_RELOAD')]);
 await s.hooks().accept(s.event(1,'Prepare a note draft.'));
 await vi.waitFor(()=>expect(s.finals).toContain('DRAFT_READY'),{timeout:4000});
 const state=(await app.host.runtime.harness.snapshot(Bindings,app.host.runtime.root.id,context))!;
 const cid=state.epochs[String(state.epoch)]!;
 expect((await app.host.runtime.harness.snapshot(MemoryDrafts,cid,context))!.drafts).toHaveLength(1);
 await s.hooks().accept(s.event(2,'/model'));
 expect(s.presentations.at(-1)!.text).toContain('Choose a model');
 const key=s.presentations.at(-1)!.buttons![0]![0]!.callback!;
 await s.hooks().accept(s.callback(3,202,key));
 expect(s.presentations.at(-1)!.text).toContain('Assistant');
 await s.hooks().accept(s.event(4,'/reload'));
 expect(s.presentations.at(-1)!.text).toContain('reloaded');
 expect((await app.host.runtime.harness.snapshot(MemoryDrafts,cid,context))!.drafts).toEqual([]);
 await s.hooks().accept(s.event(5,'A message after reload tomorrow.'));
 await vi.waitFor(()=>expect(s.finals).toContain('AFTER_RELOAD'),{timeout:4000});
 await s.hooks().accept(s.event(6,'/restart'));
 expect(s.restart).not.toHaveBeenCalled();await s.hooks().acknowledged?.(6);expect(s.restart).toHaveBeenCalledTimes(1);
 await s.hooks().accept(s.event(6,'/restart'));await s.hooks().acknowledged?.(6);expect(s.restart).toHaveBeenCalledTimes(1);
 expect(s.fatal).not.toHaveBeenCalled();
});

 test('persisted confirmations bind the paired actor and exact message across a process reopen',async()=>{
 const s=await setup();
 const {createMarkdownMemoryStore}=await import('../../.pi/skills/personal-memory/scripts/store.mjs');
 const vault=createMarkdownMemoryStore({root:s.config.memory!.vaultRoot,principal:'isaac',memoryView:'owner-and-household'});
 const note=await vault.add({type:'reference',title:'Share fixture',body:'Synthetic shared fact.'});
 await s.open([tool({action:'share',id:note.id,revision:note.revision}),fauxAssistantMessage('CONFIRMATION_READY')]);
 await s.hooks().accept(s.event(1,'Share this synthetic note with the household.'));
 await vi.waitFor(()=>expect(s.finals).toContain('CONFIRMATION_READY'),{timeout:4000});
 const presentation=s.presentations.findIndex(item=>item.buttons?.some(row=>row.some(button=>button.callback?.startsWith('cf:a:'))));
 expect(presentation).toBeGreaterThanOrEqual(0);
 const key=s.presentations[presentation]!.buttons![0]![0]!.callback!,messageId=201+presentation;
 expect(Buffer.byteLength(key)).toBeLessThanOrEqual(64);
 expect((await vault.read({id:note.id})).scope).toBe('personal');
 await s.close();await s.open();
 await s.hooks().accept(s.callback(2,messageId,key,99));
 await s.hooks().accept(s.callback(3,messageId+1,key));
 expect((await vault.read({id:note.id})).scope).toBe('personal');
 await s.hooks().accept(s.callback(4,messageId,key));
 const saved=await vault.read({id:note.id});expect(saved.scope).toBe('household');
 expect(s.presentations.at(-1)!.text).toContain('shared with the household');
 await s.hooks().accept(s.callback(5,messageId,key));
 expect((await vault.read({id:note.id})).revision).toBe(saved.revision);
 expect(s.fatal).not.toHaveBeenCalled();
});

test('real harness final snapshots contain the committed message and no completed generation partial', async()=>{
 const s=await setup();const app=await s.open([fauxAssistantMessage('SAME_FINAL'),fauxAssistantMessage('SAME_FINAL')]);
 let checked=0;
 s.onFinal(async()=>{
  const state=(await app.host.runtime.harness.snapshot(Bindings,app.host.runtime.root.id,context))!;
  const cid=state.epochs[String(state.epoch)]!;
  const watch=await watchEvents(app.host.runtime.harness,cid,context);
  try{
   expect(watch.snapshot.generation).toBeUndefined();
   const committed=watch.snapshot.entries.flatMap(entry=>entry.model??[]).filter(message=>message.role==='assistant'&&message.content.some(block=>block.type==='text'&&block.text==='SAME_FINAL'));
   expect(committed).toHaveLength(++checked);
  }finally{await watch.stop();}
 });
 for(const id of [1,2]){
  await s.hooks().accept(s.event(id,'Synthetic repeated-answer request.'));
  await vi.waitFor(()=>expect(s.finals).toHaveLength(id),{timeout:4000});
  await app.host.reconcile();
 }
 expect(checked).toBe(2);expect(s.fatal).not.toHaveBeenCalled();
});
