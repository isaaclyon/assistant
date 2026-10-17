import { createHash } from 'node:crypto';
import { defineExtension } from '@earendil-works/pi-durable';
import { DurableHost } from './host.js';
import { Bindings } from './ingress.js';
import { createMemoryOperations } from './operations.js';
import { createNativeProvider } from './provider.js';
import { loadNativeRegistry } from './registry.js';
import { createNativeTelegramTransport } from './transport.js';
import { assertNativeControl, assertNativeEnvelope, bridgeTelegram, type RawTransport } from './telegram-bridge.js';
import type { NativeConfig } from './config.js';

export interface NativeApplicationOptions {
 onFatal(error:unknown):void;
 onTransportFailure(error:unknown):void;
 provider?:Awaited<ReturnType<typeof createNativeProvider>>;
 transport?:RawTransport;
}
/** Composition for a dedicated native instance; no scheduler or legacy extension loader. */
export async function createNativeApplication(config:NativeConfig,options:NativeApplicationOptions) {
 const provider=options.provider??await createNativeProvider({credentialPath:config.credentialPath,settingsPath:config.settingsPath,account:config.account});
 let resources:Awaited<ReturnType<typeof loadNativeRegistry>>|undefined;
 let host:DurableHost|undefined;
 try {
  resources=await loadNativeRegistry({resourceRoot:config.resourceRoot,profileId:config.capabilityProfile,authorize:async()=>{
   // C2 foundation exposes no domain tools. C3 replaces this with the scoped memory policy.
   throw new Error('Domain execution is unavailable in the foundation profile');
  }});
  const operations=createMemoryOperations({authority:{check:async(operation,mode,tx)=>{
   if(!host)throw new Error('Host authority is not bound');
   const state=await tx.doc(Bindings,host.runtime.root.id);
   if(operation.binding.principal!==config.principal||operation.binding.target.chatId!==String(config.transport.allowedUserId)||operation.binding.target.threadId!==null)return false;
   if(mode!=='reconcile'&&operation.binding.epoch!==String(state.epoch))return false;
   return true;
  }}});
  resources.registry.install(defineExtension({name:'native-memory-operation-foundation',tasks:[operations.task]}));
  const raw=options.transport??createNativeTelegramTransport(config.transport.mode==='ordinary'?{
   ...config.transport,cwd:config.workspaceCwd,
  }:{mode:'restricted',socketPath:config.transport.socketPath,botId:config.transport.botId,allowedUserId:config.transport.allowedUserId});
  const transport=bridgeTelegram(config,raw,options.onTransportFailure);
  const signature=createHash('sha256').update(JSON.stringify({registry:resources.signature,instance:config.instanceId,principal:config.principal,bot:config.transport.botId,actor:config.transport.allowedUserId})).digest('hex');
  host=await DurableHost.create({stateDir:config.historyDir,inboxPath:config.inboxPath,models:provider.models,registry:resources.registry,
   agent:{model:provider.model,thinkingLevel:provider.thinkingLevel,cwd:config.workspaceCwd,instructions:[resources.instructions,...resources.skills.map(s=>s.content)].join('\n\n')},
   compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:config.capabilityProfile,registrySignature:signature},
   onEpochChange:async(tx,previous,nextEpoch)=>{for(const id of previous)await operations.invalidate(tx,id,String(nextEpoch),'new');},
   ...(config.idleHours>0?{idleMs:config.idleHours*3_600_000}:{}),
   transport,policy:envelope=>assertNativeEnvelope(config,envelope),controlPolicy:control=>assertNativeControl(config,control),onFatal:options.onFatal,
  });
  const runtime=host;
  return {host:runtime,operations,start:()=>runtime.start(),close:async()=>{
   await runtime.close();
   try{await resources!.close();}finally{provider.close();}
  }};
 } catch(error) {
  if(host)await host.close();
  try{await resources?.close();}finally{provider.close();}
  throw error;
 }
}
