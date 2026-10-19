import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, createProvider, Type } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { accept, context } from '../../src/durable/ingress.js';
import { createNativeFast, NativeFast, withNativeFast } from '../../src/durable/provider-fast.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

test('actual native Codex simple serialization preserves transcript changes and sends priority only while enabled',async()=>{
 const catalog=openaiCodexProvider(), model=catalog.getModels()[0]!;
 const token=`x.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')}.x`;
 const bodies:Record<string,any>[]=[];
 const fetch:typeof globalThis.fetch=async(_url,init)=>{
  const body=init?.body;
  bodies.push(JSON.parse(body instanceof Uint8Array?zstdDecompressSync(body).toString('utf8'):String(body)));
  const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'WIRE',annotations:[]}]};
  const events=[{type:'response.created',response:{id:'response_fixture'}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:'WIRE'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'response_fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const api=openAICodexResponsesApi();
 let enabled=true;
 const provider=createProvider({id:catalog.id,models:catalog.getModels(),auth:{apiKey:{name:'Synthetic',resolve:async()=>({auth:{apiKey:token}})}},api:{stream:(m,c,o)=>api.stream(m,c,{...o,fetch}),streamSimple:(m,c,o)=>api.streamSimple(m,c,{...o,fetch})}});
 const models=createModels();models.setProvider(withNativeFast(provider,async()=>enabled));
 const tool={name:'fixture',description:'old',parameters:Type.Object({text:Type.String()})};
 const transcript:import('@earendil-works/pi-ai').Context={messages:[
  {role:'system',content:'BASE',sections:{rules:'OLD',obsolete:'REMOVE'},toolsAdded:[tool],timestamp:0},
  {role:'user',content:'Synthetic request',timestamp:1},
  {role:'system',content:'ADDITIONAL',sections:{rules:'NEW',obsolete:null},toolsRemoved:[{name:'fixture'}],toolsAdded:[{...tool,description:'updated'}],timestamp:2},
 ]};
 const original=structuredClone(transcript);
 const result=await models.completeSimple(model,transcript,{transport:'sse',maxRetries:0,onPayload:body=>({...body as object,fixture_field:'composed'})});
 expect(result.stopReason,result.errorMessage).toBe('stop');expect(bodies[0]?.service_tier).toBe('priority');expect(bodies[0]?.fixture_field).toBe('composed');
 expect(bodies[0]?.tools).toEqual([expect.objectContaining({name:'fixture',description:'updated'})]);
 expect(JSON.stringify(bodies[0])).toContain('NEW');expect(JSON.stringify(bodies[0])).toContain('ADDITIONAL');
 expect(transcript).toEqual(original);
 enabled=false;transcript.messages.push({role:'system',content:'',toolsRemoved:[{name:'fixture'}],timestamp:3});
 await models.completeSimple(model,transcript,{transport:'sse',maxRetries:0,onPayload:body=>({...body as object,service_tier:'priority'})});
 expect(bodies[1]?.service_tier).toBeUndefined();expect(bodies[1]?.tools??[]).toEqual([]);
});

async function fixture(path?:string){
 const directory=path??await mkdtemp(join(tmpdir(),'native-fast-'));
 if(!path)cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);
 const host=await DurableHost.create({stateDir:directory,models,registry:createRegistry(),agent:{model:{provider:faux.provider.id,modelId:faux.getModel().id}},compatibility:{runtimeGeneration:'fixture',releaseSchema:1,profile:'fixture',registrySignature:'fixture'},policy(){},controlPolicy(){},transport:{async start(){},async stop(){},async sendFinal(){return {messageId:1};}}});
 cleanup.push(()=>host.close());
 const model=openaiCodexProvider().getModels()[0]!;
 const fast=createNativeFast({host:()=>host,botId:123,model:async()=>model});
 return {directory,host,fast};
}
const command=(id:string)=>`telegram-command:123:${id}`;
test('fast saved/active state and command receipts survive close and preserve pending work',async()=>{
 const first=await fixture();
 expect(await first.fast.active()).toBe(false);
 await first.fast.command(command('first'),'on');expect(await first.fast.active()).toBe(true);
 await first.fast.command(command('second'),'off');
 await first.fast.command(command('first'),'on');expect(await first.fast.active()).toBe(false);
 await expect(first.fast.command(command('first'),'off')).rejects.toThrow('identity conflict');
 await expect(first.fast.command('telegram-command:999:bad','on')).rejects.toThrow('Unauthenticated');
 // Durable accepted input is already a live native submission after admission.
 const accepted=await accept(first.host.runtime,{instance:'fixture',principal:'isaac',bot:'123',chatId:42,messageIds:[1],originalAt:1,content:'synthetic'});
 const {admit}=await import('../../src/durable/ingress.js');await admit(first.host.runtime,accepted.binding.envelope);
 expect(await first.fast.command(command('pending'),'on')).toContain('Pending:');
 expect(await first.fast.active()).toBe(false);
 await first.host.close();
 const next=await fixture(first.directory);
 expect(await next.fast.active()).toBe(false);
 expect(await next.fast.command(command('pending'),'on')).toContain('Pending:');
 const snapshot=await next.host.runtime.harness.snapshot(NativeFast,next.host.runtime.root.id,context);
 expect(snapshot).toMatchObject({active:false,saved:true});
});


test('native retry retains one final destination, completed effects and pending fast state until settlement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'native-fast-retry-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);
 let effects=0;
 const registry=createRegistry();registry.install(defineExtension({name:'fixture',tools:[defineTool({name:'effect',description:'Synthetic effect',parameters:Type.Object({}),replay:'unsafe',execute:async()=>{effects++;return {output:[{type:'text',text:'done'}]};}})]}));
 const hold=Promise.withResolvers<void>();let retried=false;
 faux.setResponses([
  fauxAssistantMessage(fauxToolCall('effect',{}),{stopReason:'toolUse'}),
  fauxAssistantMessage([],{stopReason:'error',errorMessage:'503 service unavailable'}),
  async()=>{retried=true;await hold.promise;return fauxAssistantMessage('RETRY_DONE');},
 ]);
 const finals:string[]=[];let fast:ReturnType<typeof createNativeFast>;
 const host=await DurableHost.create({stateDir:directory,models,registry,agent:{model:{provider:faux.provider.id,modelId:faux.getModel().id}},settings:{retry:{enabled:true,maxRetries:1,baseDelayMs:1,maxAgentDelayMs:1}},compatibility:{runtimeGeneration:'fixture',releaseSchema:1,profile:'fixture',registrySignature:'fixture'},policy(){},controlPolicy(){},beforeAdmission:async()=>fast.settle(),transport:{async start(){},async stop(){hold.resolve();},async sendFinal(request){finals.push(request.text);return {messageId:1};}}});
 cleanup.push(()=>host.close());fast=createNativeFast({host:()=>host,botId:123,model:async()=>openaiCodexProvider().getModels()[0]});
 await host.start();await host.receive({instance:'fixture',principal:'isaac',bot:'123',chatId:42,messageIds:[1],originalAt:1,content:'synthetic'});
 await vi.waitFor(()=>expect(retried).toBe(true));
 expect(effects).toBe(1);expect(finals).toEqual([]);
 expect(await fast.command(command('retry-pending'),'on')).toContain('Pending:');expect(await fast.active()).toBe(false);
 hold.resolve();
 await vi.waitFor(()=>expect(finals).toEqual(['RETRY_DONE']));
 await host.reconcile();expect(await fast.active()).toBe(true);expect(effects).toBe(1);
});
