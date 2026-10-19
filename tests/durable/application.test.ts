import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  await app.close();app=undefined;
  await expect(createNativeApplication({...config,principal:'emma'},{provider:provider(),transport:raw,onFatal:fatal,onTransportFailure:failure})).rejects.toThrow(/compatib|identity|profile/i);
 }finally{await app?.close();await rm(directory,{recursive:true,force:true});}
});
