import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import { loadNativeConfig, type NativeConfig } from '../../src/durable/config.js';
import { openPlacesStore } from '../../src/places-store.js';
import { PlacesApplication } from '../../src/places-application.js';
import { PlacesService } from '../../src/places-service.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';
import type { Presentation } from '../../src/durable/telegram-ui.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(seed=3,profile='durable-places-test') {
 const directory=await mkdtemp(join(tmpdir(),'native-places-app-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const stateDir=join(directory,'state'),workspaceCwd=join(directory,'workspace'),vaultRoot=join(directory,'vault');
 await Promise.all([stateDir,workspaceCwd,vaultRoot].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 const config:NativeConfig={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:'a'.repeat(40),resourceRoot:resolve(import.meta.dirname,'../..'),workspaceCwd,stateDir,capabilityProfile:profile,account:'test',credentialPath:join(directory,'unused-auth'),settingsPath:join(directory,'unused-settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(directory,'unused.sock'),botId:123,allowedUserId:42},historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json'),memory:{vaultRoot,gitAutocommit:false,legacySessionRoots:[],timeZone:'UTC',recall:'off',semantic:'off'},google:{}};
 const ownerKey='instance:test:principal:isaac';let categoryId='';
 const domain=()=>{const store=openPlacesStore(join(stateDir,'places.db'));return {store,service:new PlacesService(store,{ownerKey})};};
 const initial=domain();try{categoryId=initial.service.listCategories()[0]!.id;for(let i=0;i<seed;i++){let step=initial.service.start({name:`Seed ${i}`,categoryId,sentiment:'liked'});while(step.kind==='compare')step=initial.service.answer({insertionId:step.insertionId,revision:step.revision,existingPlaceId:step.existingPlace.id,winner:'existing'});}}finally{initial.store.close();}
 let hooks!:NativeTelegramHooks;let nextMessage=100;const presentations:Array<{messageId:number;value:Presentation}>=[],finals:string[]=[],requests:any[]=[],toasts:string[]=[];const fatal=vi.fn();let failPresent=false,lostReceipt=false,stopped=false,presentGate:Promise<void>|undefined;
 const raw={start:async(value:NativeTelegramHooks)=>{hooks=value;return 'ready' as const;},stop:async()=>{stopped=true;},deliver:async(_target:unknown,text:string)=>{finals.push(text);return ++nextMessage;},present:async(_target:unknown,value:Presentation)=>{if(failPresent)throw new Error('synthetic lost presentation');const messageId=++nextMessage;presentations.push({messageId,value});await presentGate;if(lostReceipt)throw new Error('synthetic send with lost receipt');return messageId;},edit:async()=>{},answerCallback:async(_id:string,text:string)=>{toasts.push(text);return true;}};
 let app:Awaited<ReturnType<typeof createNativeApplication>>|undefined;cleanup.push(async()=>{await app?.close();});
 const open=async(responses:any[]=[])=>{
  const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});faux.setResponses(responses.map(response=>(request:any)=>{requests.push(structuredClone(request));return typeof response==='function'?response(request):response;}));
  const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();app=await createNativeApplication(config,{provider:{models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',close:async()=>{}},transport:raw,onFatal:fatal,onTransportFailure:()=>{}});await app.start();return app;
 };
 let updateId=1;
 const accept=(text:string,extra:Record<string,unknown>={})=>{const id=updateId++;return hooks.accept({update_id:id,message:{message_id:1000+id,date:1700000000+id,from:{id:42},chat:{id:42,type:'private'},text,...extra}});};
 const callback=(messageId:number,data:string,extra:Record<string,unknown>={},sourceId?:number)=>{const id=sourceId??updateId++;return hooks.accept({update_id:id,callback_query:{id:`cb${id}`,data,from:{id:42},message:{message_id:messageId,chat:{id:42,type:'private'}},...extra}});};
 const latest=()=>presentations.at(-1)!;
 const button=(label:RegExp,view=latest())=>{const match=view.value.buttons?.flat().find(b=>label.test(b.text));if(!match||!('callback'in match))throw new Error(`No button ${label}: ${JSON.stringify(view)}`);return match.callback;};
 return {directory,config,domain,categoryId,open,accept,callback,latest,button,presentations,finals,requests,toasts,fatal,failPresent:(value:boolean)=>{failPresent=value;},loseReceipt:(value:boolean)=>{lostReceipt=value;},holdPresentation:(gate:Promise<void>)=>{presentGate=gate;},stopped:()=>stopped,close:async()=>{try{await app?.close();}finally{app=undefined;}}};
}
const call=(args:Record<string,string|number>)=>fauxAssistantMessage(fauxToolCall('rank_places',args),{stopReason:'toolUse'});
const toolResult=(request:any)=>request.messages.filter((m:any)=>m.role==='toolResult').at(-1);
const text=(message:any)=>typeof message.content==='string'?message.content:message.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');

test('native places profile hands a model add to direct category/sentiment/comparison buttons and resumes after restart',async()=>{
 const s=await setup();const app=await s.open([call({action:'categories',name:'New Cafe'}),()=>fauxAssistantMessage('UNEXPECTED_MODEL_CONTINUATION')]);
 await s.accept('Add New Cafe to my rankings');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1),{timeout:6000});await vi.waitFor(async()=>expect((await app.controls.status()).busy).toBe(false));
 expect(s.latest().value.text).toContain('New Cafe');await s.callback(s.latest().messageId,s.button(/restaurant|coffee|cafe/i));
 await s.callback(s.latest().messageId,s.button(/liked|love|good/i));expect(s.latest().value.text).toContain('New Cafe');const comparison=s.latest();const answer=s.button(/New Cafe/,comparison);
 await s.close();await s.open();await s.callback(comparison.messageId,answer);const after=s.latest();expect(after.value.text).toContain('New Cafe');
 const saved=s.domain();try{expect(saved.service.listRanking(s.categoryId).length).toBeGreaterThanOrEqual(3);}finally{saved.store.close();}
 // A consumed callback remains inert even when delivered under a new update ID.
 const count=s.presentations.length;await s.callback(comparison.messageId,answer);expect(s.presentations.length).toBe(count);expect(s.requests).toHaveLength(1);expect(s.finals).not.toContain('UNEXPECTED_MODEL_CONTINUATION');expect(s.fatal).not.toHaveBeenCalled();
});

test('native places menus bypass the model and reject wrong-message, wrong-actor and old-epoch callbacks',async()=>{
 const s=await setup();await s.open();await s.accept('/place_rankings');expect(s.requests).toHaveLength(0);const menu=s.latest();const add=s.button(/add place/i,menu);
 await s.callback(menu.messageId+99,add);expect(s.presentations).toHaveLength(1);
 await s.callback(menu.messageId,add,{from:{id:99}});await s.callback(menu.messageId,add,{message:{message_id:menu.messageId,chat:{id:99,type:'private'}}});expect(s.presentations).toHaveLength(1);
 await s.accept('/new');const count=s.presentations.length;await s.callback(menu.messageId,add);expect(s.presentations.length).toBe(count);expect(s.requests).toHaveLength(0);
});

test('uncertain direct result delivery never forwards a captured name to the model or repeats the effect',async()=>{
 const s=await setup(0);await s.open();await s.accept('/place_rankings');await s.callback(s.latest().messageId,s.button(/add place/i));const prompt=s.latest();
 s.failPresent(true);await s.accept('Captured Cafe',{reply_to_message:{message_id:prompt.messageId}});s.failPresent(false);
 expect(s.requests).toHaveLength(0);await s.accept('/place_rankings');expect(s.latest().value.text).toContain('Captured Cafe');
});

test('places profile enforces private principal and leaves old profile selections unchanged',async()=>{
 const s=await setup();const {historyDir,inboxPath,runtimeMetadataPath,...input}=s.config;const path=join(s.directory,'config.json');const load=async(value:unknown)=>{await writeFile(path,JSON.stringify(value),{mode:0o600});return loadNativeConfig(path);};
 expect(await load(input)).toMatchObject({capabilityProfile:'durable-places-test',google:{}});
 for(const principal of ['emma','household','engineering']){await expect(load({...input,principal})).rejects.toThrow(/principal/);await expect(createNativeApplication({...s.config,principal:principal as NativeConfig['principal']},{onFatal:()=>{},onTransportFailure:()=>{}})).rejects.toThrow(/principal/);}
 for(const capabilityProfile of ['durable-cli-integrations-test','durable-read-integrations-test','durable-tools-test','durable-chat-memory-test']){
  s.config.capabilityProfile=capabilityProfile;s.config.historyDir=join(s.config.stateDir,capabilityProfile);s.config.inboxPath=join(s.config.stateDir,`${capabilityProfile}.db`);if(!['durable-cli-integrations-test','durable-read-integrations-test'].includes(capabilityProfile))delete s.config.google;
  await s.open();await s.accept('/place_rankings');expect(s.requests).toHaveLength(0);expect(s.finals.at(-1)).toMatch(/unavailable/i);await s.close();
 }
});

test.each(['delete_place','delete_category','undo_addition','cancel','request_confirmation'])('places slice refuses %s through the actual native registry',async action=>{
 const s=await setup();await s.open([call({action}),(r:any)=>{expect(text(toolResult(r))).toMatch(/unavailable|guarded|unsupported/i);return fauxAssistantMessage('REFUSED');}]);await s.accept('Try synthetic unavailable operation');await vi.waitFor(()=>expect(s.finals).toContain('REFUSED'),{timeout:6000});
 const saved=s.domain();try{expect(saved.service.listRanking(s.categoryId)).toHaveLength(3);}finally{saved.store.close();}
});

test('native rank tool shares non-destructive management with the canonical application',async()=>{
 const s=await setup();const original=s.domain();let placeId:string;try{placeId=original.service.listRanking(s.categoryId)[0]!.id;}finally{original.store.close();}
 await s.open([
  call({action:'create_category',name:'Synthetic List'}),
  ()=>call({action:'rename_category',category_id:s.categoryId,name:'Renamed Restaurants'}),
  ()=>call({action:'edit_place',place_id:placeId,name:'Edited Seed',notes:'Synthetic notes'}),
  ()=>call({action:'place',place_id:placeId}),
  (r:any)=>{expect(text(toolResult(r))).toContain('Synthetic notes');return call({action:'ranking',category_id:s.categoryId,offset:1,limit:1});},
  (r:any)=>{expect(text(toolResult(r))).toContain('hasPrevious');return fauxAssistantMessage('MANAGED');},
 ]);
 await s.accept('Manage the synthetic ranking.');await vi.waitFor(()=>expect(s.finals).toContain('MANAGED'),{timeout:6000});
 const saved=s.domain();try{expect(saved.service.listCategories().map(c=>c.name)).toContain('Synthetic List');expect(saved.service.listRanking(s.categoryId)[0]).toMatchObject({name:'Edited Seed',notes:'Synthetic notes'});}finally{saved.store.close();}
});

test('new and reload expire direct capabilities while fresh commands retain the pending place name',async()=>{
 const s=await setup();const app=await s.open([call({action:'categories',name:'Saved Draft'}),()=>fauxAssistantMessage('UNEXPECTED_MODEL_CONTINUATION')]);await s.accept('Add Saved Draft');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1),{timeout:6000});await vi.waitFor(async()=>expect((await app.controls.status()).busy).toBe(false));
 const before=s.latest(),category=s.button(/Restaurants/i,before);await s.accept('/reload');const count=s.presentations.length;await s.callback(before.messageId,category);expect(s.presentations.length).toBe(count);
 await s.accept('/place_rankings');expect(s.latest().value.text).toContain('Saved Draft');const reopened=s.latest(),newCategory=s.button(/Restaurants/i,reopened);await s.accept('/new');const afterNew=s.presentations.length;await s.callback(reopened.messageId,newCategory);expect(s.presentations.length).toBe(afterNew);await s.accept('/place_rankings');expect(s.latest().value.text).toContain('Saved Draft');
});

test('concurrent redelivery of a direct edit invokes its canonical effect at most once',async()=>{
 const s=await setup();const initial=s.domain();try{const place=initial.service.listRanking(s.categoryId)[0]!;initial.service.editPlace(place.id,{notes:'Before clear'});}finally{initial.store.close();}
 await s.open();await s.accept('/place_rankings');for(const label of [/View rankings/i,/Restaurants/i,/Seed 0/,/^Manage$/,/Clear notes/i]){
  if(label.source==='Clear notes')break;await s.callback(s.latest().messageId,s.button(label));
 }
 const view=s.latest(),clear=s.button(/Clear notes/i,view);const execute=vi.spyOn(PlacesApplication.prototype,'execute');
 try{await Promise.all([s.callback(view.messageId,clear,{},600),s.callback(view.messageId,clear,{},600)]);expect(execute.mock.calls.filter(args=>args[0].action==='edit_place')).toHaveLength(1);}finally{execute.mockRestore();}
});

test('a private reply to a sent prompt with a lost receipt stays out of model history across restart',async()=>{
 const s=await setup(0);await s.open();await s.accept('/place_rankings');s.loseReceipt(true);
 await s.callback(s.latest().messageId,s.button(/add place/i));s.loseReceipt(false);const prompt=s.latest();
 expect(prompt.value.text).toMatch(/Input reference: [0-9a-f]{32}$/);
 const reply_to_message={message_id:prompt.messageId,from:{id:123,is_bot:true},chat:{id:42,type:'private'},text:prompt.value.text};
 await s.accept('Private lost-receipt name',{reply_to_message});expect(s.requests).toHaveLength(0);
 await s.close();await s.open();await s.accept('Private delayed lost-receipt name',{reply_to_message});expect(s.requests).toHaveLength(0);
 await s.accept('/place_rankings');expect(s.latest().value.text).not.toContain('Private');expect(s.fatal).not.toHaveBeenCalled();
});

test('application shutdown drains direct places work before closing the Harness',async()=>{
 const s=await setup(0),app=await s.open();await s.accept('/place_rankings');
 const gate=Promise.withResolvers<void>();s.holdPresentation(gate.promise);
 const callback=s.callback(s.latest().messageId,s.button(/add place/i));await vi.waitFor(()=>expect(s.presentations).toHaveLength(2));
 const closeHarness=vi.spyOn(app.host.runtime.harness,'close');let finished=false;
 const closing=s.close().then(()=>{finished=true;});
 await vi.waitFor(()=>expect(s.stopped()).toBe(true));expect(closeHarness).not.toHaveBeenCalled();expect(finished).toBe(false);
 gate.resolve();await callback;await closing;expect(closeHarness).toHaveBeenCalledTimes(1);expect(s.fatal).not.toHaveBeenCalled();
});


test('guarded places model preview binds direct deletion through restart and cannot pass its own token',async()=>{
 const s=await setup(3,'durable-mutations-test');const initial=s.domain();let placeId:string;try{placeId=initial.service.listRanking(s.categoryId)[0]!.id;}finally{initial.store.close();}
 const app=await s.open([call({action:'request_confirmation',confirmation_operation:'delete_place',place_id:placeId}),()=>fauxAssistantMessage('PREVIEWED')]);
 await s.accept('Delete the synthetic ranked place.');await vi.waitFor(()=>expect(s.presentations).toHaveLength(1),{timeout:6000});await vi.waitFor(async()=>expect((await app.controls.status()).busy).toBe(false));
 const preview=s.latest(),confirm=s.button(/^confirm/i,preview);expect(JSON.stringify(s.requests.slice(1))).not.toContain(confirm.split(':')[1]);await s.close();await s.open();
 await Promise.all([s.callback(preview.messageId,confirm,{},800),s.callback(preview.messageId,confirm,{},800)]);await s.callback(preview.messageId,confirm,{},801);
 const saved=s.domain();try{expect(saved.service.listRanking(s.categoryId)).toHaveLength(2);}finally{saved.store.close();}expect(s.fatal).not.toHaveBeenCalled();
});

test('guarded places direct destructive tool call stays refused with model-selected confirmation data',async()=>{
 const s=await setup(3,'durable-mutations-test');const initial=s.domain();let placeId:string;try{placeId=initial.service.listRanking(s.categoryId)[0]!.id;}finally{initial.store.close();}
 await s.open([call({action:'delete_place',place_id:placeId,confirmation_token:'model-made-token'}),(r:any)=>{expect(text(toolResult(r))).toMatch(/confirm|direct|button|unavailable/i);return fauxAssistantMessage('REFUSED');}]);
 await s.accept('Try a fabricated confirmation.');await vi.waitFor(()=>expect(s.finals).toContain('REFUSED'),{timeout:6000});const saved=s.domain();try{expect(saved.service.listRanking(s.categoryId)).toHaveLength(3);}finally{saved.store.close();}
});

test('legacy places profile preserves its catalog and hides guarded management buttons',async()=>{
 const s=await setup();const app=await s.open([call({action:'request_confirmation',confirmation_operation:'delete_place',place_id:'synthetic'}),(r:any)=>{
  expect(text(toolResult(r))).toContain('UNAVAILABLE');
  const tool=r.messages.flatMap((message:any)=>message.toolsAdded??[]).find((tool:any)=>tool.name==='rank_places');
  expect(tool.description).toBe("Maintain the user's private restaurant, coffee-shop, bar, and other place rankings. Supports categories, adding a place, durable pairwise comparisons, resume, and paginated rankings. Deleting, undoing, cancelling and confirmation requests are unavailable in this migration slice.");
  return fauxAssistantMessage('LEGACY_REFUSED');
 }]);
 await s.accept('Request a guarded change');await vi.waitFor(()=>expect(s.finals).toContain('LEGACY_REFUSED'),{timeout:6000});
 await s.accept('/place_rankings');for(const label of [/View rankings/i,/Restaurants/i,/Seed 0/,/^Manage$/])await s.callback(s.latest().messageId,s.button(label));
 expect(s.latest().value.buttons?.flat().map(button=>button.text)).not.toContain('Delete place');
 await s.accept('/place_rankings');await s.callback(s.latest().messageId,s.button(/Manage categories/i));await s.callback(s.latest().messageId,s.button(/Restaurants/i));
 expect(s.latest().value.buttons?.flat().map(button=>button.text)).not.toContain('Delete category');
 expect((await app.controls.status()).busy).toBe(false);
});
