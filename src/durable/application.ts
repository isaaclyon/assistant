import { createHash, randomUUID } from 'node:crypto';
import { defineDoc, defineExtension, type ConversationId } from '@earendil-works/pi-durable';
import { loadCapabilityProfile } from '../capabilities.js';
import { DurableHost, HostControlRejectedError } from './host.js';
import { Bindings, context } from './ingress.js';
import { createMemoryOperations } from './operations.js';
import { createNativeProvider } from './provider.js';
import { createNativeFast, withNativeFast } from './provider-fast.js';
import { createNativeUsage } from './provider-usage.js';
import { loadNativeRegistry, type NativeBundle } from './registry.js';
import { createNativeControls, NativePreferences } from './controls.js';
import { createNativeTelegramTransport } from './transport.js';
import { assertNativeControl, assertNativeEnvelope, bridgeTelegram, UiRejectedError, type NativeUiController, type RawTransport } from './telegram-bridge.js';
import { nativeBinding, nativeMemoryBinding, sourceInAuthority } from './authority.js';
import { requireProfilePolicy } from './profiles.js';
import { actorOf, chatIdOf } from './surface.js';
import { createGroupNew } from './group-new.js';
import { nativeMemoryEnvironment } from './environment.js';
import { confirmationPresentation, formatDiagnostics, type DiagnosticSection } from './telegram-ui.js';
import { dirname, join, resolve } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createTypeSafeJudge, TYPESAFE_API_KEY_FILE_ENV, type SemanticJudge } from '../semantic-judge.js';
import { createNativeConversationRouter } from './routing.js';
import { createMediaRetention } from './media-retention.js';
import { createMediaArtifactStore, type NativeImageProcessor } from './media-artifacts.js';
import { assertMediaAttachments, createAlbumJournal, createMediaIngest, createNativeInputAdapter, type MediaIngest } from './media-ingest.js';
import { createMediaSender, createNativeMediaOutbound, type NativeMediaOutbound } from './media-outbound.js';
import { MediaDeliveryError, type MediaPort } from './media-transport.js';
import { loadNativeConfig, type NativeConfig } from './config.js';
import { assertScheduleOnlyUpgrade } from './schedule-upgrade.js';

export interface NativeApplicationOptions {
 browserServices?:import('./browser.js').NativeBrowserServices;
 childSupervisor?:ReturnType<typeof import('./child-supervisor.js')['createChildSupervisor']>;
 onFatal(error:unknown):void;
 onTransportFailure(error:unknown):void;
 requestRestart?():void;
 provider?:Awaited<ReturnType<typeof createNativeProvider>>;
 /** Explicit transport and timing seams for offline native acceptance. */
 webRunFetch?:typeof fetch;
 providerStallTimeoutMs?:number;
 coordinator?:Omit<Parameters<typeof import('./coordinator.js')['startNativeJobsCoordinator']>[1], 'logger'>;
 transport?:RawTransport;
 routingJudge?:SemanticJudge;
 mediaImages?:NativeImageProcessor;
}
/** Store identity travels with the Harness, so citation locators survive moving a backup. */
export const NativeIdentity=defineDoc({kind:'bridge.identity',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({storeId:''})});
const confirmationKey=(cid:ConversationId,id:string)=>createHash('sha256').update(JSON.stringify([cid,id])).digest('hex').slice(0,32);

/** Composition for a dedicated native instance; domain modules load only after selection validation. */
export async function createNativeApplication(config:NativeConfig,options:NativeApplicationOptions) {
 await loadCapabilityProfile(config.resourceRoot,config.capabilityProfile);
 const policy=requireProfilePolicy(config.capabilityProfile);
 if(!(policy.principals as readonly string[]).includes(config.principal))throw new Error('The selected native profile does not permit this principal');
 const enabled=policy.memory!=='none';
 const canonicalMemory=policy.memory==='canonical';
 const childrenEnabled=policy.children;
 const coordinatorEnabled=config.jobsRole==='coordinator';
 const jobsEnabled=config.jobsRole!=='disabled';
 if(!(policy.jobsRoles as readonly string[]).includes(config.jobsRole))throw new Error('jobsRole must match the selected native profile');
 if(coordinatorEnabled!==!!config.coordinator)throw new Error('Coordinator configuration must match the selected native profile');
 if(coordinatorEnabled&&(policy.schedules==='required'&&!config.coordinator?.schedules||policy.schedules==='forbidden'&&config.coordinator?.schedules))throw new Error('Schedule configuration must match the selected native profile');
 if(!!config.group!==(policy.surface==='group'))throw new Error('Surface configuration must match the selected native profile');
 const parityEnabled=policy.parity,providerEnabled=policy.provider,browserEnabled=policy.browser,mutationsEnabled=policy.mutations,placesEnabled=policy.places;
 const cliEnabled=policy.cli,googleEnabled=policy.google,generalEnabled=policy.general;
 if(googleEnabled&&!config.google)throw new Error('Google reads require explicit instance configuration');
 if(enabled&&(!config.memory||(config.principal==='engineering')!==(policy.memory==='history')))throw new Error('Chat-memory profile requires scoped memory configuration');
 const schedulePrevious=config.scheduleUpgradeFrom?await loadNativeConfig(config.scheduleUpgradeFrom.configPath,{expectedSha256:config.scheduleUpgradeFrom.sha256}):undefined;
 if(schedulePrevious)assertScheduleOnlyUpgrade(config as unknown as Record<string,unknown>,schedulePrevious as unknown as Record<string,unknown>);
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
 let executionEnvironment:import('@earendil-works/pi-durable/env').ExecutionEnv|undefined;
 let coordinator:Awaited<ReturnType<typeof import('./coordinator.js')['startNativeJobsCoordinator']>>|undefined;
 let children:ReturnType<typeof import('./children.js')['createNativeChildren']>|undefined;
 let previousJobDiagnostic='';
 let reconcileJobs:((runtime:import('./ingress.js').IngressRuntime)=>Promise<void>)|undefined;
 let webRunFactory:(()=>NativeBundle)|undefined;
 let generalFactory:(()=>NativeBundle)|undefined;
 let publicWebFactory:(()=>NativeBundle)|undefined;
 let places:ReturnType<typeof import('./places.js')['createNativePlaces']>|undefined;
 let calendar:ReturnType<typeof import('./calendar.js')['createNativeCalendar']>|undefined;
 let googleFactory:(()=>NativeBundle)|undefined;
 let browser:ReturnType<typeof import('./browser.js')['createNativeBrowser']>|undefined;
 let browserGuard:ReturnType<typeof import('./browser-environment.js')['createNativeBrowserGate']>|undefined;
 let unbindBrowser:(()=>void)|undefined;
 let mediaIngest:MediaIngest|undefined;
 let mediaJournal:ReturnType<typeof createAlbumJournal>|undefined;
 let mediaOutbound:NativeMediaOutbound|undefined;
 let mediaInput:import('./ingress.js').InputAdapter|undefined;
 let mediaStore:ReturnType<typeof createMediaArtifactStore>|undefined;
 let mediaOutStore:ReturnType<typeof createMediaArtifactStore>|undefined;
 let mediaRetention:ReturnType<typeof createMediaRetention>|undefined;
 let mediaSender:ReturnType<typeof createMediaSender>|undefined;
 let debugEnabled=false;
 const debugCommands=new Set<string>();
 let debugQueued=false;
 let debugPending:DiagnosticSection[]=[];
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  debugEnabled=false;
  const failures:unknown[]=[];
  for(const cleanup of [()=>coordinator?.stop(),()=>visible?.close(),()=>browser?.close(),()=>host?.close(),()=>children?.close(),()=>places?.close(),()=>calendar?.close(),()=>executionEnvironment?.cleanup(context),()=>resources?.close(),()=>search?.close(),()=>provider.close()]){
   try{await cleanup();}catch(error){failures.push(error);}
  }
  if(!failures.length)unbindBrowser?.();
  if(failures.length)throw new AggregateError(failures,'Native application cleanup failed');
 })();
 const target={chatId:chatIdOf(config)};
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
 const raw=options.transport??createNativeTelegramTransport(config.transport.mode==='ordinary'?{...config.transport,cwd:config.workspaceCwd}:{mode:'restricted',socketPath:config.transport.socketPath,botId:config.transport.botId,allowedUserId:config.transport.allowedUserId});
 try {
  if(policy.media){
   const port:MediaPort=raw.media??{call:async()=>{throw new MediaDeliveryError('Telegram media port unavailable.',true);},file:async()=>{throw new MediaDeliveryError('Telegram media port unavailable.',true);}};
   mediaStore=createMediaArtifactStore({root:join(config.stateDir,'media')});
   const images=options.mediaImages??(await import('./media-images.js')).createNativeImageProcessor();
   mediaInput=createNativeInputAdapter(mediaStore,{images});
   const adapter=mediaInput;
   mediaJournal=createAlbumJournal(join(config.stateDir,'media-pending'));
   mediaIngest=createMediaIngest({identity:{instance:config.instanceId,principal:config.principal,bot:String(config.transport.botId)},port,store:mediaStore,journal:mediaJournal,
    authorize:record=>record.chatId===target.chatId&&(config.group?!!record.actor&&config.group.actors.some(actor=>actor.id===record.actor!.id&&actor.label===record.actor!.label):!record.actor),
    validateInput:async envelope=>{await adapter(envelope,envelope.content);}});
   mediaOutStore=createMediaArtifactStore({root:join(config.stateDir,'media-out'),limits:{maxFileBytes:50*1024*1024}});
   mediaOutbound=createNativeMediaOutbound({runtime:()=>requireHost().runtime,store:mediaOutStore,authorize:async(path,cid)=>{
    const current=requireHost();
    if(!await current.runtime.root.commit(tx=>nativeBinding(tx,current,config,cid),context))throw new Error('Current native authority rejected');
    const selected=resolve(config.workspaceCwd,path),info=await lstat(selected);
    if(!info.isFile()||info.isSymbolicLink())throw new Error('Attachment source must be a regular file');
    const canonical=await realpath(selected);
    if(!(await lstat(canonical)).isFile())throw new Error('Attachment source must be a regular file');
    return canonical;
   }});
   mediaSender=createMediaSender(port,destination=>destination.chatId===target.chatId&&destination.threadId===undefined);
  }
  if(childrenEnabled){const {createNativeChildren}=await import('./children.js');children=createNativeChildren({config,host:requireHost,provider,...(options.childSupervisor?{supervisor:options.childSupervisor}:{})});}
  if(jobsEnabled){
   const {reconcileJobHandoffs}=await import('./job-admission.js');
   reconcileJobs=async runtime=>{
    const result=await reconcileJobHandoffs({runtime,stateDir:config.stateDir,instanceId:config.instanceId,principal:config.principal,bot:String(config.transport.botId),target,policy:e=>assertNativeEnvelope(config,e),onConversation:async cid=>{await visible?.attach(cid);}});
    const counts={admitted:result.admitted,resumed:result.resumed,cancelled:result.cancelled,runsSettled:result.runsSettled,quarantined:result.quarantined.length,held:result.held.length};
    const signature=JSON.stringify(counts);
    if(signature!==previousJobDiagnostic){previousJobDiagnostic=signature;if(Object.values(counts).some(Boolean))debug('durable jobs',counts);}
   };
  }
  if(browserEnabled){
   const env=await import('./browser-environment.js');unbindBrowser=env.bindNativeBrowserEnvironment(config);
   const module=await import('./browser.js');browser=module.createNativeBrowser(config,options.browserServices);
   browserGuard=env.createNativeBrowserGate(browser.bundle().tools.map(({tool})=>tool.name));
  }
  if(generalEnabled){
   const tools=await import('./general-tools.js');
   generalFactory=()=>{const bundle=tools.createGeneralToolsBundle();return mediaOutbound?{...bundle,tools:[...bundle.tools,...mediaOutbound.bundle.tools]}:bundle;};
   publicWebFactory=(await import('./public-web.js')).createPublicWebBundle;
   if(parityEnabled){
    const {createWebRunBundle}=await import('./web-run.js');
    webRunFactory=()=>createWebRunBundle({models:provider.models,...(options.webRunFetch?{fetch:options.webRunFetch}:{}),sessionId:async cid=>{
     const identity=await requireHost().runtime.harness.snapshot(NativeIdentity,requireHost().runtime.root.id,context);
     if(!identity?.storeId)throw new Error('Native web identity unavailable');
     return `${identity.storeId}:${cid}`;
    }});
   }
   executionEnvironment=tools.createNativeExecutionEnvironment(config);
  }
  if(mutationsEnabled){
   const module=await import('./calendar.js');calendar=module.createNativeCalendar({config,host:requireHost,present:async(destination,presentation)=>{if(!transport)throw new Error('Telegram presenter unavailable');return transport.presenter.present(destination,presentation);}});
  }
  if(googleEnabled&&!mutationsEnabled){
   const google=await import('./google-read.js');googleFactory=()=>google.createGoogleReadBundle(config);
  }
  if(placesEnabled){
   const module=await import('./places.js');places=module.createNativePlaces({config,host:requireHost,present:async(destination,presentation)=>{if(!transport)throw new Error('Telegram presenter unavailable');return transport.presenter.present(destination,presentation);}});
  }
  if(enabled){
   // No canonical domain code imports before every selected path is validated above.
   const [memory,markdown,searching,recall,contexts,history,usage]=await Promise.all([
    import('./memory.js'),import('./memory-executor.js'),import('./search.js'),import('./recall.js'),import('./context.js'),import('./history-native.js'),import('../memory-usage.js'),
   ]);
   if(canonicalMemory)memoryModule=memory;
   const selected=config.memory!;
   const env=nativeMemoryEnvironment(config);
   const view=markdown.defaultMemoryView(config.principal);
   search=searching.createNativeSearch({stateDir:config.stateDir,instanceId:config.instanceId,principalId:config.principal,memoryView:view.memoryView,
    vaultRoot:selected.vaultRoot,resourceRoot:config.resourceRoot,legacySessionRoots:selected.legacySessionRoots,env,stores:()=>store?[store]:[]});
   const service=search;
   searchFactory=()=>({...searching.createSearchBundle(service),close:async()=>{}});
   // History-only profiles stop after session search and the history adapter.
   initializeHistory=(storeId)=>{store=history.createHarnessHistoryStore(requireHost().runtime,{instanceId:config.instanceId,principal:config.principal,storeId});};
   if(canonicalMemory){
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
     if(!sources.length||!sources.every(source=>sourceInAuthority(config,source)))return undefined;
     return {principalId:config.principal,memoryView:view.memoryView,env,stateDir:config.stateDir,vaultRoot:selected.vaultRoot,resourceRoot:config.resourceRoot,
      sessionRoots:selected.legacySessionRoots,rootConversationId:current.runtime.root.id,timeZone:selected.timeZone};
    },
   });
   prepareIntent=input=>markdown.prepareMemoryIntent({root:selected.vaultRoot,forbiddenRoots:[config.resourceRoot,config.workspaceCwd],view},input);
   memoryDomain=domain;
   }
  }
  const operations=createMemoryOperations({...(executor?{executor}:{}),authority:{check:async(operation,mode,tx)=>{
   const current=requireHost();
   if(!canonicalMemory||!config.memory||operation.binding.principal!==config.principal||operation.binding.target.chatId!==String(target.chatId)||operation.binding.target.threadId!==null)return false;
   // Reconciliation may inspect an old epoch's own receipt; it cannot repeat Markdown.
   if(mode==='reconcile')return true;
   const state=await tx.doc(Bindings,current.runtime.root.id);
   const cid=state.epochs[String(state.epoch)];
   if(cid===undefined)return false;
   const binding=await nativeMemoryBinding(tx,current,config,cid);
   return !!binding&&binding.epoch===operation.binding.epoch;
  }}});
  if(canonicalMemory){
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
   if(childrenEnabled&&name==='background-children')return children!.bundle();
   if(browserEnabled&&name==='private-browser')return browser!.bundle();
   if(generalEnabled&&name==='general-tools')return generalFactory!();
   if(parityEnabled&&name==='web-run')return webRunFactory!();
   if(generalEnabled&&name==='public-web')return publicWebFactory!();
   if(mutationsEnabled&&name==='google-mutations')return {...calendar!.bundle(),close:async()=>{}};
   if(googleEnabled&&!mutationsEnabled&&name==='google-reads')return googleFactory!();
   if(placesEnabled&&name==='places')return {...places!.bundle(),close:async()=>{}}; // Application owns the shared domain lifetime across reloads.
   if(canonicalMemory&&name==='memory')return {name,version:1,tools:[memoryTool!],close:async()=>{}};
   if(name==='search')return searchFactory!();
   if(canonicalMemory&&name==='core-memory')return contextFactory!();
   if(['reload','restart','skills','debug',...(providerEnabled?['fast','usage']:[])].includes(name))return {name,version:1,tools:[],close:async()=>{}};
   throw new Error('Unknown native bundle');
  };
  const load=()=>loadNativeRegistry({resourceRoot:config.resourceRoot,...(schedulePrevious?{previousResourceRoot:schedulePrevious.resourceRoot}:config.instructionUpgradeFrom?{previousResourceRoot:join(dirname(config.resourceRoot),config.instructionUpgradeFrom)}:{}),profileId:config.capabilityProfile,bundleContext:{bundle},...(browserGuard?{executionGuard:browserGuard.run}:{}),authorize:async(_name,api,ctx)=>{
   const binding=await api.commit(tx=>nativeBinding(tx,requireHost(),config,api.conversationId),ctx);
   if(!binding)throw new Error('Current native authority rejected');
  }});
  const install=(selected:Awaited<ReturnType<typeof load>>)=>selected.registry.install(defineExtension({name:'native-memory-operation-foundation',tasks:[operations.task]}));
  resources=await load();install(resources);
  const selectedSignature=resources.signature;
  const controls=createNativeControls({config,host:requireHost,models:provider.models,requestRestart:()=>options.requestRestart?.(),
   invalidate:async()=>{
    browser?.cancel();
    await places?.invalidate();
    await calendar?.invalidate();
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
  const fast=providerEnabled?createNativeFast({host:requireHost,botId:config.transport.botId,model:async()=>{const m=await controls.currentModel();return provider.models.getModel(m.provider,m.modelId);}}):undefined;
  const usage=providerEnabled?createNativeUsage({models:provider.models,getModel:controls.currentModel}):undefined;
  let selectedProvider=fast?withNativeFast(provider.provider,fast.active):provider.provider;
  if(parityEnabled){const {withNativeRetry}=await import('./provider-retry.js');selectedProvider=withNativeRetry(selectedProvider,{...(options.providerStallTimeoutMs===undefined?{}:{stallTimeoutMs:options.providerStallTimeoutMs})});}
  if(fast||parityEnabled)provider.models.setProvider(selectedProvider);
  const ui:NativeUiController={
   command:async request=>{
    try{
     const status=await controls.status();
     switch(request.name){
      case 'menu':return {view:{kind:'menu',state:{model:status.modelLabel,thinking:status.thinking,busy:status.busy,...(placesEnabled?{places:true}:{})}}};
      case 'deploy':throw new UiRejectedError('Use /deploy as a command.');
      case 'place_rankings':if(!places)throw new UiRejectedError('Places is unavailable.');return places.command(request);
      case 'model':return {view:{kind:'models',choices:controls.models(),current:status.model,page:Number(request.arg??0)}};
      case 'thinking':return {view:{kind:'thinking',levels:await controls.thinkingLevels(),current:status.thinking}};
      case 'selectModel':await controls.setModel(request.commandId,request.arg);return {toast:'Model selected'};
      case 'selectThinking':await controls.setThinking(request.commandId,request.arg);return {toast:'Thinking selected'};
      case 'fast':if(!fast)throw new UiRejectedError('Fast mode is unavailable.');return {view:{kind:'text',text:await fast.command(request.commandId,(request.arg??'status') as 'on'|'off'|'status')}};
      case 'usage':if(!usage)throw new UiRejectedError('Usage is unavailable.');return {view:{kind:'text',text:await usage()}};
      case 'skills':return {view:{kind:'skills',skills:resources!.skills.map(skill=>({name:skill.content.match(/^name:\s*(.+)$/m)?.[1]?.trim()??'personal-memory'}))}};
      case 'debug':
       if(!debugCommands.has(request.commandId)){debugCommands.add(request.commandId);debugEnabled=!debugEnabled;}
       return {view:{kind:'text',text:`Debug messages ${debugEnabled?'enabled':'disabled'} for this private chat.`}};
      case 'reload':await controls.reload(request.commandId);return {view:{kind:'text',text:'Selected capabilities reloaded. Pending memory drafts and confirmations expired.'}};
      case 'restart':return {view:{kind:'text',text:'Restart requested.'},afterAcknowledgement:await controls.restart(request.commandId)};
     }
    }catch(error){if(error instanceof HostControlRejectedError)throw new UiRejectedError(error.message);throw error;}
   },
   ...(config.group?{groupNew:createGroupNew({config,host:requireHost,present:async(destination,presentation)=>{if(!transport)throw new Error('Telegram presenter unavailable');return transport.presenter.present(destination,presentation);}})}:{}),
   ...(calendar?{calendar:(request)=>calendar!.callback(request)}:{}),
   ...(places?{places:(request)=>places!.callback(request),placesInput:(request)=>places!.input(request)}: {}),
   confirmation:async request=>{
    if(!memoryModule)throw new UiRejectedError('This action is unavailable.');
    const current=requireHost();
    const decided=await current.runtime.root.commit(async tx=>{
     const state=await tx.doc(Bindings,current.runtime.root.id),cid=state.epochs[String(state.epoch)];
     if(cid===undefined)return undefined;
     const binding=await nativeMemoryBinding(tx,current,config,cid);
     if(!binding||!actorOf(config,request.actorId)||request.principal!==binding.principal||String(request.target.chatId)!==binding.target.chatId||request.target.threadId!==undefined)return undefined;
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
  transport=bridgeTelegram(config,raw,options.onTransportFailure,{...(enabled?{ui}:{}),...(mediaIngest?{media:mediaIngest}:{}),commands:enabled?['menu','model','thinking','new','abort','stop','compact','reload','restart','skills','debug',...(providerEnabled?['fast','usage']:[]),...(placesEnabled?['place_rankings']:[]),...(policy.commands??[])]:['new','abort','stop','compact'],...(policy.commands?.includes('deploy')?{deployPrompt:async()=>{
   const path=join(config.resourceRoot,'.pi/prompts/deploy.md');
   return (await readFile(path,'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
  }}:{})});
  const bridge=transport;
  const legacySignature=(registry:string,resourceRoot:string,selected:NativeConfig=config)=>createHash('sha256').update(JSON.stringify({registry,instance:selected.instanceId,principal:selected.principal,bot:selected.transport.botId,actor:selected.transport.allowedUserId,...(selected.group?{group:selected.group}:{}),...(selected.routing?{routing:selected.routing}:{}),memory:selected.memory??null,...(jobsEnabled?{jobs:{role:selected.jobsRole,stateDir:selected.stateDir,...(coordinatorEnabled?{coordinator:selected.coordinator}:{})}}:{}),...(googleEnabled?{google:selected.google}:{} ),...(cliEnabled?{cli:selected.cli??{}}:{}),...(browserEnabled?{browser:selected.browser}:{}),...(childrenEnabled?{children:{workspaceCwd:selected.workspaceCwd,resourceRoot,account:selected.account,credentialPath:selected.credentialPath,settingsPath:selected.settingsPath}}:{})})).digest('hex');
  // Reconstruct exact versioned contracts; only the pinned configuration differs.
  const signatureFor=(selected:NativeConfig,registry:string)=>createHash('sha256').update(JSON.stringify({
   legacy:legacySignature(registry,dirname(selected.resourceRoot),selected),
   ...(selected.scheduleClient?{scheduleClient:selected.scheduleClient}:{}),
   transport:selected.transport,workspaceCwd:selected.workspaceCwd,account:selected.account,
   credentialPath:selected.credentialPath,settingsPath:selected.settingsPath,
  })).digest('hex');
  const signature=signatureFor(config,resources.compatibilitySignature);
  const previousCompatibility=resources.previousSignature&&config.instructionUpgradeFrom?{
   runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:config.capabilityProfile,
   registrySignature:legacySignature(resources.previousSignature,join(dirname(config.resourceRoot),config.instructionUpgradeFrom)),
  }:undefined;
  const scheduleUpgradeCompatibilities=schedulePrevious&&resources.previousSignature?[
   {runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:config.capabilityProfile,registrySignature:legacySignature(resources.previousSignature,schedulePrevious.resourceRoot,schedulePrevious)},
   {runtimeGeneration:'pi-durable-1.3.0',releaseSchema:2,profile:config.capabilityProfile,registrySignature:signatureFor(schedulePrevious,resources.compatibilitySignature)},
  ]:undefined;
  // The reader delegates to the active registry after a safe idle reload.
  const registry={snapshot:()=>resources!.registry.snapshot(),subscribe:(listener:()=>void)=>{registryListeners.add(listener);return()=>{registryListeners.delete(listener);};}};
  host=await DurableHost.create({stateDir:config.historyDir,inboxPath:config.inboxPath,models:provider.models,registry,
   ...(executionEnvironment?{env:({cwd})=>{if(cwd!==config.workspaceCwd)throw new Error('Tool working directory differs from selected workspace');return executionEnvironment;}}:{}),
   agent:{model:provider.model,thinkingLevel:provider.thinkingLevel,cwd:config.workspaceCwd,instructions:[resources.instructions,...resources.skills.map(s=>s.content)].join('\n\n')},
   compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:2,profile:config.capabilityProfile,registrySignature:signature},
   instructionRevision:resources.signature,...(previousCompatibility?{previousCompatibility}:{}),
   ...(scheduleUpgradeCompatibilities?{scheduleUpgradeCompatibilities}:{}),
   onEpochChange:async(tx,previous,nextEpoch)=>{browser?.cancel();for(const id of previous){if(memoryModule)await memoryModule.invalidateMemoryState(tx,operations,id,String(nextEpoch),'new');else await operations.invalidate(tx,id,String(nextEpoch),'new');}},
   onConversation:async cid=>{await visible?.attach(cid);},
   ...(fast?{beforeAdmission:fast.settle}:{}),
   ...(mediaInput?{inputAdapter:mediaInput}:{}),
   ...(mediaOutbound?{recoveryPreflight:async()=>{await mediaRetention!.reconcile(true);},reconcileOutputs:async()=>{await mediaOutbound!.reconcile(mediaSender!,async(destination,text)=>{await raw.deliver(destination,text);});await mediaRetention!.reconcile();}}:{}),
   ...((reconcileJobs||children)?{reconcileSources:async(runtime:import('./ingress.js').IngressRuntime)=>{await reconcileJobs?.(runtime);await children?.cleanup();}}:{}),
   ...(config.idleHours>0?{idleMs:config.idleHours*3_600_000}:{}),
   transport:{start:bridge.start,stop:async()=>{await Promise.all([bridge.stop(),places?.close(),calendar?.close(),browser?.close()]);},sendFinal:async request=>{await visible?.finish();return bridge.sendFinal(request);}},
   policy:async(envelope,phase)=>{assertNativeEnvelope(config,envelope);if(mediaStore){if(phase==='recovery')await mediaRetention!.validate(envelope);else await assertMediaAttachments(envelope,mediaStore);}},controlPolicy:control=>assertNativeControl(config,control),onFatal:options.onFatal,
  });
  const runtime=host;
  if(mediaStore&&mediaOutStore)mediaRetention=createMediaRetention({runtime:()=>runtime.runtime,inbound:mediaStore,outbound:mediaOutStore,inboundPending:async()=>!!(await mediaJournal!.list()).length});
  if(config.routing)runtime.runtime.routeHuman=createNativeConversationRouter({runtime:runtime.runtime,judge:options.routingJudge??createTypeSafeJudge({env:{[TYPESAFE_API_KEY_FILE_ENV]:config.routing.judgeKeyFile},timeoutMs:3000,maxAttempts:1}),onError:()=>debug('conversation routing','Judgment unavailable; current conversation kept.')});
  const storeId=await runtime.runtime.root.commit(async tx=>{const identity=await tx.doc(NativeIdentity,runtime.runtime.root.id);identity.storeId||=randomUUID();return identity.storeId;},context);
  initializeHistory?.(storeId);
  await controls.restore();
  if(enabled){const {createVisibleEvents}=await import('./visible-events.js');visible=createVisibleEvents({host:requireHost,config,stream:bridge.stream,typing:bridge.typing,activity:bridge.activity,cwd:config.workspaceCwd,debug});}
  const lintMemory=async()=>{
   if(!canonicalMemory||!search||!config.memory)throw new Error('Memory lint requires the chat-memory profile');
   const {executeMemoryOperation}=await import('../../.pi/skills/personal-memory/scripts/memory.mjs');
   return executeMemoryOperation('lint',{}, {env:nativeMemoryEnvironment(config),cwd:config.workspaceCwd,sourceResolver:search.provenanceResolver});
  };
  const restartAtOpen=(await runtime.runtime.harness.snapshot(NativePreferences,runtime.runtime.root.id,context))?.restartNotice?.requestId;
  const inspectJobs=async()=>{
   if(!jobsEnabled)return undefined;
   const recipient=await (await import('./job-admission.js')).inspectJobHandoffs({runtime:runtime.runtime,stateDir:config.stateDir});
   if(!coordinatorEnabled)return recipient;
   const occurrences=await (await import('../job-occurrences.js')).inspectJobOccurrenceLedger(config.coordinator!.coordinatorStateDir);
   return {...recipient,coordinator:{running:!!coordinator,occurrences}};
  };
  return {host:runtime,operations,controls,search,lintMemory,inspectJobs,inspectChildren:async()=>children?.inspect(),start:async()=>{
   try{
    await runtime.validateRecovery();
    if(coordinatorEnabled&&!coordinator){
     const module=await import('./coordinator.js');
     const diagnostic=()=>debug('durable coordinator',{event:'diagnostic'});
     coordinator=await module.startNativeJobsCoordinator({instanceId:config.instanceId,stateDir:config.stateDir,coordinator:config.coordinator!,...(config.google?{google:config.google}:{})},{...options.coordinator,logger:{info:diagnostic,warn:diagnostic,error:diagnostic}});
    }
    await runtime.start();
    if(restartAtOpen)await controls.notifyRestart(async()=>{await bridge.presenter.present(target,{text:'Restart complete.'});},restartAtOpen);
   }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Native application startup failed');}throw error;}
  },close};
 } catch(error) {
  try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Native application construction failed');}
  throw error;
 }
}
