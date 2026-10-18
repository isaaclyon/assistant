import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { accept, Bindings, context, type SourceEnvelope } from '../../src/durable/ingress.js';
import { createNativeConversationRouter } from '../../src/durable/routing.js';
import type { SemanticJudge } from '../../src/semantic-judge.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const envelope=(id=1,at=1000):SourceEnvelope=>({instance:'test',principal:'person',bot:'bot',chatId:10,messageIds:[id],originalAt:at,content:'Synthetic human text',attachments:[]});
async function setup(){
 const path=await mkdtemp(join(tmpdir(),'native-routing-'));cleanup.push(()=>rm(path,{recursive:true,force:true}));
 const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}}),models=createModels();faux.setResponses([fauxAssistantMessage('Synthetic answer')]);models.setProvider(faux.provider);const model=faux.getModel();
 const host=await DurableHost.create({stateDir:path,models,registry:createRegistry(),agent:{model:{provider:model.provider,modelId:model.id},instructions:'Synthetic'},compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:'fixture',registrySignature:'fixture'},transport:{async start(){},async stop(){},async sendFinal(){return {messageId:1};}},policy:()=>{},controlPolicy:()=>{}});cleanup.push(()=>host.close());
 const accepted=await accept(host.runtime,envelope());await host.start();await host.reconcile();
 const binding=(await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context))!.sources[accepted.key]!;
 await (await host.runtime.harness.submission(binding.submissionId!,context))!.wait(context);await host.reconcile();return {host,faux};
}
it('uses the existing bounded question after strictly more than fifteen human-idle minutes and persists the decision',async()=>{
 const {host,faux}=await setup();let calls=0;const judged:unknown[]=[];
 const judge:SemanticJudge=async request=>{calls++;judged.push(request);return {model:'jev-fixture',probabilities:{same_conversation:0.2}};};
 const route=createNativeConversationRouter({runtime:host.runtime,judge});
 expect(await route(envelope(2,901000))).toEqual({expectedEpoch:0,rotate:false});expect(calls).toBe(0);
 const input=envelope(3,901001);expect(await route(input)).toEqual({expectedEpoch:0,rotate:true});expect(calls).toBe(1);
 expect(JSON.stringify(judged)).toContain('same_conversation');expect(JSON.stringify(judged)).not.toContain('base64');
 const reopened=createNativeConversationRouter({runtime:host.runtime,judge});expect(await reopened(input)).toEqual({expectedEpoch:0,rotate:true});expect(calls).toBe(1);expect(faux.state.callCount).toBe(1);
 await expect(reopened({...input,content:'Changed payload'})).rejects.toThrow(/payload conflict/);
});
it.each([0.3,0.5,1])('preserves continuity for probability %s',async probability=>{
 const {host}=await setup();const route=createNativeConversationRouter({runtime:host.runtime,judge:async()=>({model:'jev-fixture',probabilities:{same_conversation:probability}})});
 expect((await route(envelope(2,901001))).rotate).toBe(false);
});
it('keeps context for judge failure, proactive input, out-of-order input and media without leaking error text',async()=>{
 const {host}=await setup();let calls=0,reports=0;
 const route=createNativeConversationRouter({runtime:host.runtime,judge:async()=>{calls++;throw new Error('PRIVATE diagnostic');},onError:()=>{reports++;}});
 expect((await route({...envelope(2,901001),proactive:true})).rotate).toBe(false);
 expect((await route(envelope(3,999))).rotate).toBe(false);
 expect((await route({...envelope(4,901001),attachments:[{privatePath:'/never/send'}]})).rotate).toBe(false);expect(calls).toBe(0);
 expect((await route(envelope(5,901001))).rotate).toBe(false);expect(calls).toBe(1);expect(reports).toBe(1);
 expect((await route(envelope(5,901001))).rotate).toBe(false);expect(calls).toBe(1);
});
it('accepts a routed human once in the next epoch and keeps the original event time',async()=>{
 const {host}=await setup();let calls=0;
 host.runtime.routeHuman=createNativeConversationRouter({runtime:host.runtime,judge:async()=>{calls++;return {model:'fixture',probabilities:{same_conversation:0.1}};}});
 const input=envelope(2,901001),first=await accept(host.runtime,input,1),again=await accept(host.runtime,input,1);
 expect(again.binding.conversationId).toBe(first.binding.conversationId);expect(first.binding.epoch).toBe(1);expect(calls).toBe(1);
 const bindings=await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context);expect(bindings!.lastHumanAt).toBe(input.originalAt);expect(Object.keys(bindings!.epochs)).toEqual(['0','1']);
});
it('does not rotate a busy conversation or use idle-hours while Jev routing is selected',async()=>{
 const {host}=await setup();let calls=0;
 host.runtime.routeHuman=createNativeConversationRouter({runtime:host.runtime,judge:async()=>{calls++;return {model:'fixture',probabilities:{same_conversation:0.1}};}});
 const queued=await accept(host.runtime,envelope(2,2000),1);expect(queued.binding.epoch).toBe(0);
 const later=await accept(host.runtime,envelope(3,902001),1);expect(later.binding.epoch).toBe(0);expect(calls).toBe(0);
});

it('does not apply an old rotation decision to a newer manually selected epoch',async()=>{
 const {host}=await setup();let calls=0;
 const route=createNativeConversationRouter({runtime:host.runtime,judge:async()=>{calls++;return {model:'jev-fixture',probabilities:{same_conversation:0.1}};}});
 const input=envelope(2,901001);expect((await route(input)).rotate).toBe(true);
 await host.runtime.root.commit(async tx=>{(await tx.doc(Bindings,host.runtime.root.id)).epoch++;},context);
 expect(await route(input)).toEqual({expectedEpoch:1,rotate:false});expect(calls).toBe(1);
});
