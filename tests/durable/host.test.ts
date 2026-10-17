import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from '@earendil-works/pi-ai';
import { AgentDoc, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { DurableHost, HostState, type HostConfig, type HostControl } from '../../src/durable/host.js';
import { accept, admit, Bindings, context, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { Deliveries, splitFinal, type FinalRequest } from '../../src/durable/delivery.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function directory(){const path=await mkdtemp(join(tmpdir(),'durable-host-'));cleanup.push(()=>rm(path,{recursive:true,force:true}));return path;}
const envelope=(id=1):SourceEnvelope=>({instance:'test',principal:'person',bot:'bot',chatId:10,threadId:2,messageIds:[id],originalAt:1700000000000+id,content:`input ${id}`});
const control=(type:HostControl['type'],requestId:string=type):HostControl=>({type,requestId,principal:'person',target:{chatId:10,threadId:2}});
async function host(path:string,options:Partial<HostConfig>={},responses=[answer('ANSWER')]){
  const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});faux.setResponses(responses);
  const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();const sent:FinalRequest[]=[];
  const h=await DurableHost.create({stateDir:path,models,registry:createRegistry(),agent:{model:{provider:model.provider,modelId:model.id},instructions:'Synthetic host'},compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:'fixture',registrySignature:'fixture-v1'},transport:{async start(){},async stop(){},async sendFinal(r){sent.push(r);return {messageId:sent.length};}},policy:e=>{if(e.principal!=='person')throw new Error('Unauthorized');},controlPolicy:c=>{if(c.principal!=='person')throw new Error('Unauthorized');},settings:{retry:{enabled:false},compaction:{enabled:false}},...options});cleanup.push(()=>h.close());return {h,faux,sent};
}
async function settled(h:DurableHost,e:SourceEnvelope){await h.reconcile();const state=await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context);const id=state!.sources[sourceKey(e)]!.submissionId!;return (await h.runtime.harness.submission(id,context))!.wait(context);}

it('enforces one OS writer, WAL/FULL, durable admission dedup and delivery after reopen',async()=>{
  const path=await directory();const {h}=await host(path);
  await expect(host(path)).rejects.toThrow();
  expect(await h.runtime.store.database.get('PRAGMA synchronous')).toEqual({synchronous:2});
  await accept(h.runtime,envelope());const submission=await admit(h.runtime,envelope());await submission!.wait(context);
  // Simulate lost admission receipt and inbox removal after native commit.
  await h.runtime.root.commit(async tx=>{delete (await tx.doc(Bindings,h.runtime.root.id)).sources[sourceKey(envelope())]!.submissionId;},context);
  h.runtime.store.inbox.persist(sourceKey(envelope()),JSON.stringify({...envelope(),proactive:false,attachments:[]}),envelope().originalAt);
  await h.close();
  const next=await host(path);await next.h.start();await settled(next.h,envelope());await next.h.reconcile();
  expect(next.faux.state.callCount).toBe(0);expect(next.sent).toHaveLength(1);expect(next.sent[0]!.target).toEqual({chatId:10,threadId:2});
  await next.h.receive(envelope());await next.h.reconcile();expect(next.sent).toHaveLength(1);
  await expect(next.h.receive({...envelope(),content:'changed'})).rejects.toThrow('payload conflict');
});

it('serializes idle rotation and preserves old binding, timestamp, target and policy',async()=>{
  const {h}=await host(await directory(),{idleMs:100});
  await accept(h.runtime,envelope(),100);
  await accept(h.runtime,{...envelope(2),originalAt:envelope().originalAt+101},100);
  const state=await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context);
  expect(state!.sources[sourceKey(envelope())]!.epoch).toBe(0);
  expect(state!.sources[sourceKey(envelope(2))]!.epoch).toBe(1);
  await expect(h.receive({...envelope(3),principal:'stranger'})).rejects.toThrow('Unauthorized');
  await expect(h.control(control('new'))).rejects.toThrow('busy');
  await settled(h,envelope());await settled(h,envelope(2));
  await expect(h.control(control('new'))).rejects.toThrow('busy');
  await h.control(control('new','new-retry'));await h.control(control('new','new-retry'));
  expect((await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context))!.epoch).toBe(2);
  await accept(h.runtime,{...envelope(3),originalAt:envelope().originalAt+999},100);
  expect((await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context))!.epoch).toBe(2);
});

it.each(['uncertain','retryable'] as const)('reconciles %s delivery and does not blindly repeat',async status=>{
  let calls=0;const path=await directory();const transport:HostConfig['transport']={async start(){},async stop(){},async sendFinal(){calls++;throw Object.assign(new Error('fixture'),status==='retryable'?{definitelyNotSent:true}:{});}};
  const {h}=await host(path,{transport});await accept(h.runtime,envelope());await (await admit(h.runtime,envelope()))!.wait(context);await h.reconcile();expect(calls).toBe(1);await h.close();
  const next=await host(path,{transport:{...transport,async sendFinal(){calls++;return {messageId:7};}}});await next.h.start();
  expect(calls).toBe(status==='retryable'?2:1);
  const items=Object.values((await next.h.runtime.harness.snapshot(Deliveries,next.h.runtime.root.id,context))!.items);
  expect(items[0]!.segments[0]!.status).toBe(status==='retryable'?'delivered':'uncertain');
});

it('suppresses proactive NO_REPLY and empty final, but delivers human literal NO_REPLY',async()=>{
  const {h,sent}=await host(await directory(),{},[answer(' NO_REPLY '),answer('NO_REPLY'),answer('')]);
  for(const e of [{...envelope(),proactive:true},envelope(2),envelope(3)]){await h.receive(e);await settled(h,e);await h.reconcile();}
  expect(sent.map(s=>s.text)).toEqual(['NO_REPLY']);
  const chunks=splitFinal('😀'.repeat(6000));expect(chunks.join('')).toBe('😀'.repeat(6000));expect(chunks.every(c=>c.length<=3500&&!/[\uD800-\uDBFF]$/.test(c))).toBe(true);
});

function held(){const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const registry=createRegistry();registry.install(defineExtension({name:'held',tools:[defineTool({name:'held',description:'fixture',parameters:Type.Object({}),replay:'safe',execute:async(_a,_api,ctx)=>{started.resolve();await Promise.race([release.promise,new Promise<void>((_resolve,reject)=>{if(ctx.abortSignal?.aborted)reject(new Error('aborted'));else ctx.abortSignal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})]);return {output:[{type:'text',text:'OK'}]};}})]}));return {started,release,registry};}
it.each(['abort','stop'] as const)('%s persists exact work and replay cannot cancel later input',async type=>{
  const t=held(),path=await directory();const {h}=await host(path,{registry:t.registry},[answer(fauxToolCall('held',{}),{stopReason:'toolUse'}),answer('QUEUED')]);
  await h.receive(envelope());await t.started.promise;await h.receive(envelope(2));await h.reconcile();
  await h.control(control(type));
  const state=await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context);const queued=await h.runtime.harness.submission(state!.sources[sourceKey(envelope(2))]!.submissionId!,context);
  if(type==='stop')expect(await queued!.status(context)).toMatchObject({status:'unanswered',reason:'aborted'});
  else{await h.reconcile();expect(await queued!.wait(context)).toMatchObject({status:'done'});}
  await h.close();const next=await host(path);await next.h.start();await next.h.control(control(type));await next.h.receive(envelope(3));expect(await settled(next.h,envelope(3))).toMatchObject({status:'done'});
});

it('wakes FIFO after terminal failure without repeating failed input',async()=>{
  const t=held();const {h,faux}=await host(await directory(),{registry:t.registry},[answer(fauxToolCall('held',{}),{stopReason:'toolUse'}),answer('',{stopReason:'error',errorMessage:'fixture failure'}),answer('SECOND'),answer('THIRD')]);
  await h.receive(envelope());await t.started.promise;await h.receive(envelope(2));await h.receive(envelope(3));await h.reconcile();t.release.resolve();await settled(h,envelope());await h.reconcile();await settled(h,envelope(2));await settled(h,envelope(3));expect(faux.state.callCount).toBe(4);
});

it('preflights compatibility and stored resource selection before transport or generation',async()=>{
  const path=await directory();const {h}=await host(path);await accept(h.runtime,envelope());const state=await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context);const id=state!.sources[sourceKey(envelope())]!.conversationId;
  await h.runtime.root.commit(async tx=>{(await tx.doc(AgentDoc,id)).extensions=['missing'];},context);await h.close();
  let starts=0;const next=await host(path,{transport:{async start(){starts++;},async stop(){},async sendFinal(){return {messageId:1};}}});await expect(next.h.start()).rejects.toThrow('Stored agent selection');expect(starts).toBe(0);expect(next.faux.state.callCount).toBe(0);await next.h.close();
  await expect(host(path,{compatibility:{runtimeGeneration:'bad',releaseSchema:1,profile:'fixture',registrySignature:'fixture-v1'}})).rejects.toThrow('Incompatible');
});

it('retains pending control correlation and rejects changed control payload',async()=>{
  const {h}=await host(await directory());await h.control(control('new'));
  await expect(h.control({...control('new'),target:{chatId:99}})).rejects.toThrow('Control payload conflict');
  expect((await h.runtime.harness.snapshot(HostState,h.runtime.root.id,context))!.controls.new!.status).toBe('done');
});

it('rejects new during manual compaction and abort cancels that active compaction',async()=>{
  const {h,faux}=await host(await directory(),{settings:{retry:{enabled:false},compaction:{enabled:false,keepRecentTokens:0}}});await h.receive(envelope());await settled(h,envelope());await h.receive(envelope(2));await settled(h,envelope(2));
  const started=Promise.withResolvers<void>();
  faux.setResponses([async(_request,options)=>{started.resolve();await new Promise<void>((_resolve,reject)=>{if(options?.signal?.aborted)reject(new Error('aborted'));else options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return answer('summary');}]);
  await h.control(control('compact'));await started.promise;
  await expect(h.control(control('new'))).rejects.toThrow('busy');
  await h.control(control('abort'));
  await expect(h.control(control('new'))).rejects.toThrow('busy');
  await h.control(control('new','new-after-abort'));
  expect((await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context))!.epoch).toBe(1);
});

it('preserves a pending exact abort target across restart without aborting later work',async()=>{
  const path=await directory(),t=held();const {h}=await host(path,{registry:t.registry},[answer(fauxToolCall('held',{}),{stopReason:'toolUse'}),answer('FIRST')]);
  await h.receive(envelope());await t.started.promise;
  const realAbort=h.runtime.harness.abortTask.bind(h.runtime.harness);
  h.runtime.harness.abortTask=async()=>{throw new Error('crash before abort')};
  await expect(h.control(control('abort'))).rejects.toThrow('crash before abort');
  h.runtime.harness.abortTask=realAbort;
  t.release.resolve();await settled(h,envelope());await h.close();
  const next=await host(path);await next.h.start();await next.h.receive(envelope(2));expect(await settled(next.h,envelope(2))).toMatchObject({status:'done'});
  expect((await next.h.runtime.harness.snapshot(HostState,next.h.runtime.root.id,context))!.controls.abort!.status).toBe('done');
});

it('fails closed on inbox persistence errors before acknowledging acceptance',async()=>{
  const {InboxStorageError}=await import('../../src/durable/storage.js');let reports=0;
  const {h}=await host(await directory(),{onFatal(){reports++;}});
  h.runtime.store.inbox.persist=()=>{throw new InboxStorageError('synthetic disk failure')};
  await expect(h.receive(envelope())).rejects.toThrow('synthetic disk failure');
  await expect(h.receive(envelope(2))).rejects.toThrow('not accepting');
  expect(h.health).toBe('failed');expect(reports).toBe(1);
});

it('persists busy control rejection so transport replay after restart cannot rotate later',async()=>{
  const path=await directory(),first=await host(path);
  await accept(first.h.runtime,envelope());
  await expect(first.h.control(control('new'))).rejects.toThrow('busy');
  await first.h.close();
  const next=await host(path);await next.h.start();await settled(next.h,envelope());
  await expect(next.h.control(control('new'))).rejects.toThrow('busy');
  expect((await next.h.runtime.harness.snapshot(Bindings,next.h.runtime.root.id,context))!.epoch).toBe(0);
  await next.h.control(control('new','fresh-control'));
  expect((await next.h.runtime.harness.snapshot(Bindings,next.h.runtime.root.id,context))!.epoch).toBe(1);
});
