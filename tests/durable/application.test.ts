import { createHash } from 'node:crypto';
import { HostState } from '../../src/durable/host.js';
import { context } from '../../src/durable/ingress.js';
import { mkdir, mkdtemp, writeFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import type { NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

test('production composition accepts a private source, delivers, reopens and deduplicates without ambient capabilities',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'native-app-'));
 const resourceRoot=join(directory,'release'),stateDir=join(directory,'state'),workspaceCwd=join(directory,'workspace');
 await Promise.all([join(resourceRoot,'.pi'),stateDir,workspaceCwd].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 await writeFile(join(resourceRoot,'.pi/instructions.md'),'SELECTED_NATIVE_INSTRUCTIONS');
 await writeFile(join(workspaceCwd,'AGENTS.md'),'UNSELECTED_WORKSPACE_SECRET');
 await writeFile(join(resourceRoot,'.pi/capabilities.json'),JSON.stringify({version:1,resources:{extensions:[],skills:[],instructions:[{id:'test',path:'.pi/instructions.md',enabled:true}]},profiles:[{id:'durable-foundation-test',extensions:[],skills:[],instructions:'test'}]}));
 const config:NativeConfig={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:'a'.repeat(40),resourceRoot,workspaceCwd,stateDir,capabilityProfile:'durable-foundation-test',account:'test',credentialPath:join(directory,'unused-auth'),settingsPath:join(directory,'unused-settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(directory,'unused.sock'),botId:123,allowedUserId:42},historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json')};
 const requests:unknown[]=[];
 function provider(){const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});faux.setResponses([async(request)=>{requests.push(structuredClone(request));return fauxAssistantMessage('NATIVE_FINAL');}]);const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();return {models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off' as const,close(){}};}
 let hooks!:NativeTelegramHooks; const sent:{chatId:number;text:string}[]=[];
 const raw={start:async(value:NativeTelegramHooks)=>{hooks=value;return 'ready' as const;},stop:async()=>{},deliver:async(target:{chatId:number},text:string)=>{sent.push({chatId:target.chatId,text});return 50+sent.length;},answerCallback:async()=>true};
 const fatal=vi.fn(),failure=vi.fn();
 let app:Awaited<ReturnType<typeof createNativeApplication>>|undefined;
 try{
  app=await createNativeApplication(config,{provider:provider(),transport:raw,onFatal:fatal,onTransportFailure:failure});await app.start();
  const event={update_id:7,message:{message_id:99,date:123456,from:{id:42},chat:{id:42,type:'private'},text:'synthetic question'}};
  await hooks.accept(event);
  await vi.waitFor(()=>expect(sent).toEqual([{chatId:42,text:'NATIVE_FINAL'}]),{timeout:3000,interval:10});
  expect(JSON.stringify(requests)).toContain('SELECTED_NATIVE_INSTRUCTIONS');expect(JSON.stringify(requests)).not.toContain('UNSELECTED_WORKSPACE_SECRET');
  await app.close();app=undefined;
  app=await createNativeApplication(config,{provider:provider(),transport:raw,onFatal:fatal,onTransportFailure:failure});await app.start();await hooks.accept(event);await app.host.reconcile();
  expect(requests).toHaveLength(1);expect(sent).toHaveLength(1);expect(fatal).not.toHaveBeenCalled();
  // Reconstruct the real v1 composition with synthetic data, not the new implementation.
  const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const legacyRegistry=hash({profileId:config.capabilityProfile,extensionNames:[],bundleVersions:[],toolNames:[],toolSignatures:[],instructions:'SELECTED_NATIVE_INSTRUCTIONS',skills:[]});
  const legacySignature=hash({registry:legacyRegistry,instance:config.instanceId,principal:config.principal,bot:123,actor:42,memory:null});
  await app.host.runtime.root.commit(async tx=>{const state=await tx.doc(HostState,app!.host.runtime.root.id);state.compatibility={runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:config.capabilityProfile,registrySignature:legacySignature};state.instructionRevision=null;},context);
  await app.close();app=undefined;
  const prior='b'.repeat(40),next='c'.repeat(40);
  await cp(resourceRoot,join(directory,prior),{recursive:true});await cp(resourceRoot,join(directory,next),{recursive:true});
  await writeFile(join(directory,next,'.pi/instructions.md'),'UPDATED_NATIVE_INSTRUCTIONS');
  const upgraded={...config,resourceRoot:join(directory,next),releaseSha:next,instructionUpgradeFrom:prior};
  await expect(createNativeApplication({...upgraded,instructionUpgradeFrom:undefined},{provider:provider(),transport:raw,onFatal:fatal,onTransportFailure:failure})).rejects.toThrow('Incompatible');
  app=await createNativeApplication(upgraded,{provider:provider(),transport:raw,onFatal:fatal,onTransportFailure:failure});
  expect((await app.host.inspect()).compatibility?.releaseSchema).toBe(1);
  await app.start();await hooks.accept({...event,update_id:8,message:{...event.message,message_id:100,text:'next question'}});
  await vi.waitFor(()=>expect(sent).toHaveLength(2),{timeout:3000,interval:10});
  expect(JSON.stringify(requests.at(-1))).toContain('UPDATED_NATIVE_INSTRUCTIONS');
  expect((await app.host.inspect()).compatibility?.releaseSchema).toBe(2);
  await app.close();app=undefined;
  // Subsequent text-only updates need no legacy migration and affect the same conversation.
  await writeFile(join(directory,next,'.pi/instructions.md'),'LATER_NATIVE_INSTRUCTIONS');
  app=await createNativeApplication({...upgraded,instructionUpgradeFrom:undefined},{provider:provider(),transport:raw,onFatal:fatal,onTransportFailure:failure});
  await app.start();await hooks.accept({...event,update_id:9,message:{...event.message,message_id:101,text:'another question'}});
  await vi.waitFor(()=>expect(sent).toHaveLength(3),{timeout:3000,interval:10});
  expect(JSON.stringify(requests.at(-1))).toContain('LATER_NATIVE_INSTRUCTIONS');
  await app.close();app=undefined;
  await expect(createNativeApplication({...config,principal:'emma'},{provider:provider(),transport:raw,onFatal:fatal,onTransportFailure:failure})).rejects.toThrow(/compatib|identity|profile/i);
 }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});
