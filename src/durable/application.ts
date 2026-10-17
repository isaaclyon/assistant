import { createHash, randomUUID } from 'node:crypto';
import { defineDoc, defineExtension, type ConversationId } from '@earendil-works/pi-durable';
import { loadCapabilityProfile } from '../capabilities.js';
import { DurableHost, HostControlRejectedError } from './host.js';
import { Bindings, context } from './ingress.js';
import { createMemoryOperations } from './operations.js';
import { createNativeProvider } from './provider.js';
import { loadNativeRegistry, type NativeBundle } from './registry.js';
import { createNativeControls, NativePreferences } from './controls.js';
import { createNativeTelegramTransport } from './transport.js';
import { assertNativeControl, assertNativeEnvelope, bridgeTelegram, UiRejectedError, type NativeUiController, type RawTransport } from './telegram-bridge.js';
import { nativeMemoryBinding } from './authority.js';
import { nativeMemoryEnvironment } from './environment.js';
import { confirmationPresentation, formatDiagnostics, type DiagnosticSection } from './telegram-ui.js';
import type { NativeConfig } from './config.js';

export interface NativeApplicationOptions {
 onFatal(error:unknown):void;
 onTransportFailure(error:unknown):void;
 requestRestart?():void;
 provider?:Awaited<ReturnType<typeof createNativeProvider>>;
 transport?:RawTransport;
}
/** Store identity travels with the Harness, so citation locators survive moving a backup. */
export const NativeIdentity=defineDoc({kind:'bridge.identity',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({storeId:''})});
const confirmationKey=(cid:ConversationId,id:string)=>createHash('sha256').update(JSON.stringify([cid,id])).digest('hex').slice(0,32);

/** Composition for a dedicated native instance; domain modules load only after selection validation. */
export async function createNativeApplication(config:NativeConfig,options:NativeApplicationOptions) {
 await loadCapabilityProfile(config.resourceRoot,config.capabilityProfile);
 const enabled=config.capabilityProfile==='durable-chat-memory-test';
 if(enabled&&(!config.memory||config.principal==='engineering'))throw new Error('Chat-memory profile requires scoped memory configuration');
 const provider=options.provider??await createNativeProvider({credentialPath:config.credentialPath,settingsPath:config.settingsPath,account:config.account});
 let resources:Awaited<ReturnType<typeof loadNativeRegistry>>|undefined;
 let host:DurableHost|undefined;
 let visible:Awaited<ReturnType<typeof import('./visible-events.js')['createVisibleEvents']>>|undefined;
 let search:ReturnType<typeof import('./search.js')['createNativeSearch']>|undefined;
 let store:import('./history-native.js').NativeHistoryStore|undefined;
 let memoryModule:typeof import('./memory.js')|undefined;
 let memoryTool:import('./registry.js').NativeTool|undefined;
 let contextFactory:(()=>NativeBundle)|undefined;
 let searchFactory:(()=>NativeBundle)|undefined;
 let executor:import('./operations.js').MemoryOperationExecutor|undefined;
 let memoryDomain:import('./memory-domain.js').MemoryDomain|undefined;
 let initializeHistory:((storeId:string)=>void)|undefined;
 let prepareIntent:((input:import('./memory-executor.js').PrepareMemoryIntentInput)=>Promise<{intent:import('./operations.js').MemoryIntent}>)|undefined;
 const registryListeners=new Set<()=>void>();
 let debugEnabled=false;
 const debugCommands=new Set<string>();
 let debugQueued=false;
 let debugPending:DiagnosticSection[]=[];
 const target={chatId:config.transport.allowedUserId};
 const requireHost=()=>{if(!host)throw new Error('Host authority is not bound');return host;};
 let transport:ReturnType<typeof bridgeTelegram>|undefined;
 const debug=(title:string,value:unknown)=>{
  if(!debugEnabled||!transport)return;
  const text=typeof value==='string'?value:JSON.stringify(value);
  debugPending.push({title,lines:[text??'']});debugPending=debugPending.slice(-8);
  if(debugQueued)return;
  debugQueued=true;
  queueMicrotask(()=>{
   debugQueued=false;const sections=debugPending;debugPending=[];
   if(debugEnabled&&transport)void transport.presenter.present(target,formatDiagnostics(sections)).catch(()=>{});
  });
 };
 try {
  if(enabled){
   // No canonical domain code imports before every selected path is validated above.
   const [memory,markdown,searching,recall,contexts,history,usage]=await Promise.all([
    import('./memory.js'),import('./memory-executor.js'),import('./search.js'),import('./recall.js'),import('./context.js'),import('./history-native.js'),import('../memory-usage.js'),
   ]);
   memoryModule=memory;
   const selected=config.memory!;
   const env=nativeMemoryEnvironment(config);
   const view=markdown.defaultMemoryView(config.principal);
   search=searching.createNativeSearch({stateDir:config.stateDir,instanceId:config.instanceId,principalId:config.principal,memoryView:view.memoryView,
    vaultRoot:selected.vaultRoot,resourceRoot:config.resourceRoot,legacySessionRoots:selected.legacySessionRoots,env,stores:()=>store?[store]:[]});
   const service=search;
   searchFactory=()=>({...searching.createSearchBundle(service),close:async()=>{}});
   const domain=memory.createCanonicalMemoryDomain({env,cwd:config.workspaceCwd,
    findDuplicates:async draft=>{
     const page=await service.memorySearch({query:`${draft.title}\n${draft.body}`.slice(0,512),limit:5});
     if(!page.ok)throw new Error('Duplicate search unavailable');
     const result=page.result as {results:unknown[];retrieval?:unknown;index?:{status?:string}};
     if(result.index?.status!=='fresh')throw new Error('Duplicate search is incomplete');
     return {results:result.results,retrieval:result.retrieval};
    },recordRead:id=>usage.appendMemoryRead(config.stateDir,id,new Date()),
   });
   executor=markdown.createMarkdownMemoryExecutor({root:selected.vaultRoot,forbiddenRoots:[config.resourceRoot,config.workspaceCwd],git:selected.gitAutocommit,env});
   const recallService=recall.createDomainRecallServices({index:service.memoryIndexAccess});
   contextFactory=()=>contexts.createContextBundle({harness:()=>requireHost().runtime.harness,recall:recallService,debug,
    scope:async(api,ctx)=>{
     const current=requireHost();
     const state=await api.snapshot(Bindings,current.runtime.root.id,ctx);
     if(state?.epochs[String(state.epoch)]!==api.conversationId)return undefined;
     const sources=Object.values(state.sources).filter(source=>source.conversationId===api.conversationId&&!source.cancelled);
     if(!sources.length||sources.some(source=>source.principal!==config.principal||source.chatId!==target.chatId||source.threadId!==null))return undefined;
     return {principalId:config.principal,memoryView:view.memoryView,env,stateDir:config.stateDir,vaultRoot:selected.vaultRoot,resourceRoot:config.resourceRoot,
      sessionRoots:selected.legacySessionRoots,rootConversationId:current.runtime.root.id,timeZone:selected.timeZone};
    },
   });
   // Keep host construction lazy for the history adapter.
   initializeHistory=(storeId)=>{store=history.createHarnessHistoryStore(requireHost().runtime,{instanceId:config.instanceId,principal:config.principal,storeId});};
   prepareIntent=input=>markdown.prepareMemoryIntent({root:selected.vaultRoot,forbiddenRoots:[config.resourceRoot,config.workspaceCwd],view},input);
   memoryDomain=domain;
  }
  const operations=createMemoryOperations({...(executor?{executor}:{}),authority:{check:async(operation,mode,tx)=>{
   const current=requireHost();
   if(!enabled||!config.memory||operation.binding.principal!==config.principal||operation.binding.target.chatId!==String(target.chatId)||operation.binding.target.threadId!==null)return false;
   // Reconciliation may inspect an old epoch's own receipt; it cannot repeat Markdown.
   if(mode==='reconcile')return true;
   const state=await tx.doc(Bindings,current.runtime.root.id);
   const cid=state.epochs[String(state.epoch)];
   if(cid===undefined)return false;
   const binding=await nativeMemoryBinding(tx,current,config,cid);
   return !!binding&&binding.epoch===operation.binding.epoch;
  }}});
  if(enabled){
   memoryTool=memoryModule!.createMemoryTool({operations,handler:{name:executor!.name,version:executor!.version},domain:memoryDomain!,prepareIntent:prepareIntent!,
    resolveBinding:(tx,cid)=>nativeMemoryBinding(tx,requireHost(),config,cid),
    presenter:{present:async({conversationId,operation,preview})=>{
     if(!transport)throw new Error('Telegram presenter unavailable');
     const label=operation.intent.action==='delete'?'Delete':'Share with household';
     const sent=await transport.presenter.present(target,confirmationPresentation(confirmationKey(conversationId,operation.id),`${label} “${preview.title}” (${preview.type})?`));
     return {messageId:String(sent.messageId)};
    }},
   });
  }
  const bundle=(name:string):NativeBundle=>{
   if(!enabled)throw new Error('Native domain bundles are unavailable for this profile');
   if(name==='memory')return {name,version:1,tools:[memoryTool!],close:async()=>{}};
   if(name==='search')return searchFactory!();
   if(name==='core-memory')return contextFactory!();
   if(['reload','restart','skills','debug'].includes(name))return {name,version:1,tools:[],close:async()=>{}};
   throw new Error('Unknown native bundle');
  };
  const load=()=>loadNativeRegistry({resourceRoot:config.resourceRoot,profileId:config.capabilityProfile,bundleContext:{bundle},authorize:async(_name,api,ctx)=>{
   const binding=await api.commit(tx=>nativeMemoryBinding(tx,requireHost(),config,api.conversationId),ctx);
   if(!binding)throw new Error('Current memory authority rejected');
  }});
  const install=(selected:Awaited<ReturnType<typeof load>>)=>selected.registry.install(defineExtension({name:'native-memory-operation-foundation',tasks:[operations.task]}));
  resources=await load();install(resources);
  const selectedSignature=resources.signature;
  const controls=createNativeControls({config,host:requireHost,models:provider.models,requestRestart:()=>options.requestRestart?.(),
   invalidate:async()=>{
    const current=requireHost();
    await current.runtime.root.commit(async tx=>{const state=await tx.doc(Bindings,current.runtime.root.id);for(const cid of Object.values(state.epochs)){
     if(memoryModule)await memoryModule.invalidateMemoryState(tx,operations,cid,String(state.epoch),'reload');
     else await operations.invalidate(tx,cid,String(state.epoch),'reload');
    }},context);
   },
   reload:async()=>{
    const replacement=await load();
    if(replacement.signature!==selectedSignature){await replacement.close();throw new HostControlRejectedError('The selected release changed. Restart with reviewed compatible resources.');}
    try{install(replacement);}catch(error){try{await replacement.close();}catch{/* Preserve the installation error. */}throw error;}
    const previous=resources!;resources=replacement;
    for(const listener of registryListeners){try{listener();}catch{console.warn('Native registry subscriber notification failed');}}
    // Publication succeeded. Cleanup failure must not turn that fact into an
    // interrupted reload receipt or expose bundle error payloads.
    try{await previous.close();}catch{console.warn('Previous native registry cleanup failed after reload');}
   },
  });
  const ui:NativeUiController={
   command:async request=>{
    try{
     const status=await controls.status();
     switch(request.name){
      case 'menu':return {view:{kind:'menu',state:{model:status.modelLabel,thinking:status.thinking,busy:status.busy}}};
      case 'model':return {view:{kind:'models',choices:controls.models(),current:status.model,page:Number(request.arg??0)}};
      case 'thinking':return {view:{kind:'thinking',levels:await controls.thinkingLevels(),current:status.thinking}};
      case 'selectModel':await controls.setModel(request.commandId,request.arg);return {toast:'Model selected'};
      case 'selectThinking':await controls.setThinking(request.commandId,request.arg);return {toast:'Thinking selected'};
      case 'skills':return {view:{kind:'skills',skills:resources!.skills.map(skill=>({name:skill.content.match(/^name:\s*(.+)$/m)?.[1]?.trim()??'personal-memory'}))}};
      case 'debug':
       if(!debugCommands.has(request.commandId)){debugCommands.add(request.commandId);debugEnabled=!debugEnabled;}
       return {view:{kind:'text',text:`Debug messages ${debugEnabled?'enabled':'disabled'} for this private chat.`}};
      case 'reload':await controls.reload(request.commandId);return {view:{kind:'text',text:'Selected capabilities reloaded. Pending memory drafts and confirmations expired.'}};
      case 'restart':return {view:{kind:'text',text:'Restart requested.'},afterAcknowledgement:await controls.restart(request.commandId)};
     }
    }catch(error){if(error instanceof HostControlRejectedError)throw new UiRejectedError(error.message);throw error;}
   },
   confirmation:async request=>{
    if(!memoryModule)throw new UiRejectedError('This action is unavailable.');
    const current=requireHost();
    const decided=await current.runtime.root.commit(async tx=>{
     const state=await tx.doc(Bindings,current.runtime.root.id),cid=state.epochs[String(state.epoch)];
     if(cid===undefined)return undefined;
     const binding=await nativeMemoryBinding(tx,current,config,cid);
     if(!binding||request.actorId!==config.transport.allowedUserId||request.principal!==binding.principal||String(request.target.chatId)!==binding.target.chatId||request.target.threadId!==undefined)return undefined;
     const {MemoryOperations}=await import('./operations.js');
     const op=(await tx.doc(MemoryOperations,cid)).operations.find(item=>confirmationKey(cid,item.id)===request.key);
     if(!op)return undefined;
     const decision=await memoryModule!.decideMemoryCallback(tx,operations,cid,{token:op.approval.token,principal:request.principal,target:binding.target,messageId:String(request.messageId),choice:request.choice});
     return decision.accepted?{cid,...decision}:undefined;
    },context);
    if(!decided)throw new UiRejectedError('This confirmation expired or was already used.');
    if(decided.taskId)await current.runtime.harness.waitForTask(decided.taskId,context);
    const op=await current.runtime.root.commit(tx=>memoryModule!.readMemoryOperation(tx,decided.cid,decided.operationId),context);
    if(!op)throw new Error('Memory operation missing');
    return {view:{kind:'text',text:memoryModule.memoryOutcomeMessage(op)},toast:'Recorded'};
   },
  };
  const raw=options.transport??createNativeTelegramTransport(config.transport.mode==='ordinary'?{...config.transport,cwd:config.workspaceCwd}:{mode:'restricted',socketPath:config.transport.socketPath,botId:config.transport.botId,allowedUserId:config.transport.allowedUserId});
  transport=bridgeTelegram(config,raw,options.onTransportFailure,{...(enabled?{ui}:{}),commands:enabled?['menu','model','thinking','new','abort','stop','compact','reload','restart','skills','debug']:['new','abort','stop','compact']});
  const bridge=transport;
  const signature=createHash('sha256').update(JSON.stringify({registry:resources.signature,instance:config.instanceId,principal:config.principal,bot:config.transport.botId,actor:config.transport.allowedUserId,memory:config.memory??null})).digest('hex');
  // The reader delegates to the active registry after a safe idle reload.
  const registry={snapshot:()=>resources!.registry.snapshot(),subscribe:(listener:()=>void)=>{registryListeners.add(listener);return()=>{registryListeners.delete(listener);};}};
  host=await DurableHost.create({stateDir:config.historyDir,inboxPath:config.inboxPath,models:provider.models,registry,
   agent:{model:provider.model,thinkingLevel:provider.thinkingLevel,cwd:config.workspaceCwd,instructions:[resources.instructions,...resources.skills.map(s=>s.content)].join('\n\n')},
   compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:config.capabilityProfile,registrySignature:signature},
   onEpochChange:async(tx,previous,nextEpoch)=>{for(const id of previous){if(memoryModule)await memoryModule.invalidateMemoryState(tx,operations,id,String(nextEpoch),'new');else await operations.invalidate(tx,id,String(nextEpoch),'new');}},
   onConversation:async cid=>{await visible?.attach(cid);},
   ...(config.idleHours>0?{idleMs:config.idleHours*3_600_000}:{}),
   transport:{start:bridge.start,stop:bridge.stop,sendFinal:async request=>{await visible?.finish();return bridge.sendFinal(request);}},
   policy:envelope=>assertNativeEnvelope(config,envelope),controlPolicy:control=>assertNativeControl(config,control),onFatal:options.onFatal,
  });
  const runtime=host;
  const storeId=await runtime.runtime.root.commit(async tx=>{const identity=await tx.doc(NativeIdentity,runtime.runtime.root.id);identity.storeId||=randomUUID();return identity.storeId;},context);
  initializeHistory?.(storeId);
  await controls.restore();
  if(enabled){const {createVisibleEvents}=await import('./visible-events.js');visible=createVisibleEvents({host:requireHost,config,stream:bridge.stream,debug});}
  const lintMemory=async()=>{
   if(!search||!config.memory)throw new Error('Memory lint requires the chat-memory profile');
   const {executeMemoryOperation}=await import('../../.pi/skills/personal-memory/scripts/memory.mjs');
   return executeMemoryOperation('lint',{}, {env:nativeMemoryEnvironment(config),cwd:config.workspaceCwd,sourceResolver:search.provenanceResolver});
  };
  const restartAtOpen=(await runtime.runtime.harness.snapshot(NativePreferences,runtime.runtime.root.id,context))?.restartNotice?.requestId;
  return {host:runtime,operations,controls,search,lintMemory,start:async()=>{await runtime.start();if(restartAtOpen)await controls.notifyRestart(async()=>{await bridge.presenter.present(target,{text:'Restart complete.'});},restartAtOpen);},close:async()=>{
   debugEnabled=false;
   await visible?.close();
   await runtime.close();
   try{await resources!.close();await search?.close();}finally{provider.close();}
  }};
 } catch(error) {
  await visible?.close();
  if(host)await host.close();
  try{await resources?.close();await search?.close();}finally{provider.close();}
  throw error;
 }
}
