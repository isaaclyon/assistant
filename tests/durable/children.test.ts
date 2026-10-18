import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { createNativeChildren, NativeChildren, type ChildBatch } from '../../src/durable/children.js';
import { Bindings, accept, acceptChildReport, admit, context, normalize, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { ChildArtifacts } from '../../src/durable/child-artifacts.js';
import { CHILD_RETENTION_MS, type ChildManifest } from '../../src/durable/child-contracts.js';
import { openHostStorage } from '../../src/durable/storage.js';
import type { NativeConfig } from '../../src/durable/config.js';

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const call=(args:unknown)=>answer(fauxToolCall('background_subagents',args as never),{stopReason:'toolUse'});
async function setup(options:{barrier?:(id:string)=>Promise<void>}={}){
 const dir=await mkdtemp(join(tmpdir(),'native-children-'));cleanup.push(()=>rm(dir,{force:true,recursive:true}));
 const stateDir=join(dir,'state'),workspace=join(dir,'workspace');await mkdir(stateDir,{mode:0o700});await mkdir(workspace);
 const config={stateDir,workspaceCwd:workspace,resourceRoot:workspace,principal:'isaac',instanceId:'test',credentialPath:join(dir,'unused-auth'),settingsPath:join(dir,'unused-settings'),account:'test',transport:{botId:123,allowedUserId:42}} as NativeConfig;
 const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}}),models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
 const requests:any[]=[],finals:{text:string;target:unknown}[]=[];
 const gate=Promise.withResolvers<void>(),active=new Set<string>();const artifacts=new ChildArtifacts(stateDir);
 const run=vi.fn(async(batchId:string,jobId:string,control:any)=>{
  active.add(batchId);
  try{
   await Promise.race([gate.promise,new Promise((_,reject)=>control.signal.addEventListener('abort',()=>reject(control.signal.reason),{once:true}))]);
   if(!await control.canRun())return undefined;
   const m=await artifacts.readManifest(batchId,jobId),cancelled=await control.isCancelled();
   const outcome={version:1 as const,batchId,jobId,launchId:m.launchId,status:cancelled?'cancelled' as const:'completed' as const,output:cancelled?'Cancelled':'PRIVATE_CHILD_RESULT',finishedAt:Date.now()};
   await artifacts.writeOutcome(outcome);return outcome;
  }finally{active.delete(batchId);}
 });
 const supervisor={run,active:(id:string)=>active.has(id),close:async()=>{}};
 let h!:DurableHost,clock=Date.now();
 const service=createNativeChildren({config,host:()=>h,provider:{models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',close(){}},supervisor,now:()=>clock,onTombstone:options.barrier});
 const registry=createRegistry();const bundle=service.bundle();registry.install(defineExtension({name:bundle.name,...bundle.contributions,tools:bundle.tools.map(x=>x.tool)}));
 h=await DurableHost.create({stateDir:join(dir,'main'),models,registry,agent:{model:{provider:model.provider,modelId:model.id},instructions:'Synthetic test',cwd:workspace},compatibility:{runtimeGeneration:'test',releaseSchema:1,profile:'test',registrySignature:'test'},policy:()=>{},controlPolicy:()=>{},settings:{retry:{enabled:false},compaction:{enabled:false}},transport:{start:async()=>{},stop:async()=>{},sendFinal:async r=>{finals.push(r);return {messageId:finals.length};}}});
 cleanup.push(async()=>{gate.resolve();await h.close();await service.close();});
 const responses=(...items:any[])=>faux.setResponses(items.map(item=>(req:any)=>{requests.push(structuredClone(req));return typeof item==='function'?item(req):item;}));
 const receive=(id:number,text:string)=>h.receive({instance:'test',principal:'isaac',bot:'123',chatId:42,messageIds:[id],originalAt:1700000000000+id,content:text});
 const state=()=>h.runtime.harness.snapshot(NativeChildren,h.runtime.root.id,context);
 const batches=async()=>Object.values((await state())?.batches??{});
 return {get h(){return h;},async reopen(){const config=h.config;await h.close();h=await DurableHost.create(config);await h.start();},service,dir,artifacts,modelKey:`${model.provider}/${model.id}`,run,gate,requests,finals,responses,receive,batches,state,clock:(v:number)=>clock=v};
}

test('background tasks hold IDs only, survive parent idle/new and synthesize once in original conversation',async()=>{
 const s=await setup();
 s.responses(call({operation:'launch',tasks:[{task:'PRIVATE_TASK',context:'PRIVATE_CONTEXT',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'),answer('CURRENT_CONVERSATION'),answer('SYNTHESIS'));
 await s.h.start();await s.receive(1,'Delegate the explicit research task');
 await vi.waitFor(()=>expect(s.finals.map(x=>x.text)).toEqual(['LAUNCHED']));
 const [before]=await s.batches();expect(before!.jobs).toHaveLength(1);
 const task=await s.h.runtime.harness.getTask(before!.jobs[0]!.taskId!,context);
 expect(task!.input).toEqual({batchId:before!.id,jobId:before!.jobs[0]!.id});
 expect(task!.background).toBe(true);expect(task!.abandonOnRestart).not.toBe(true);
 const original=before!.origin.conversationId;
 const priorHuman=(await s.h.runtime.harness.snapshot(Bindings,s.h.runtime.root.id,context))!.lastHumanAt;
 await s.h.rotate('rotate-test','isaac',{chatId:42});await s.receive(2,'New conversation');
 await vi.waitFor(()=>expect(s.finals.map(x=>x.text)).toContain('CURRENT_CONVERSATION'));
 s.gate.resolve();
 await vi.waitFor(async()=>expect((await s.batches())[0]!.report.status).toBe('done'),{timeout:6000});
 await s.h.reconcile();await s.h.reconcile();
 expect(s.finals.map(x=>x.text)).toEqual(['LAUNCHED','CURRENT_CONVERSATION','SYNTHESIS']);
 const bindings=(await s.h.runtime.harness.snapshot(Bindings,s.h.runtime.root.id,context))!;
 const report=Object.values(bindings.sources).find(x=>x.envelope.child)!;
 expect(report.conversationId).toBe(original);expect(report.epoch).toBe(0);expect(bindings.epoch).toBe(1);
 expect(bindings.lastHumanAt).toBe(priorHuman+1);expect(report.envelope.content).toContain('PRIVATE_CHILD_RESULT');
 expect(s.requests.at(-1).messages.some((m:any)=>JSON.stringify(m).includes('PRIVATE_CHILD_RESULT'))).toBe(true);
 expect(s.run).toHaveBeenCalledTimes(1);expect(s.finals.every(x=>JSON.stringify(x.target)==='{"chatId":42}')).toBe(true);
 s.responses(call({operation:'inspect',job_id:before!.jobs[0]!.id}),(request:any)=>{expect(JSON.stringify(request.messages.at(-1))).toContain('PRIVATE_CHILD_RESULT');return answer('INSPECTED');});
 await s.receive(3,'Inspect that earlier job');await vi.waitFor(()=>expect(s.finals.at(-1)?.text).toBe('INSPECTED'));
});

test('cancellation records a request and waits for verified terminal worker outcome',async()=>{
 const s=await setup();s.responses(call({operation:'launch',tasks:[{task:'Research',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'));
 await s.h.start();await s.receive(1,'Research');await vi.waitFor(()=>expect(s.finals).toHaveLength(1));
 const [b]=await s.batches();
 s.responses(call({operation:'cancel',batch_id:b!.id}),answer('CANCEL_REQUESTED'),answer('CANCEL_SYNTHESIS'));
 await s.receive(2,'Cancel it');await vi.waitFor(()=>expect(s.finals).toHaveLength(2));
 expect((await s.batches())[0]!.jobs[0]).toMatchObject({status:'running',cancelRequested:true});
 s.gate.resolve();await vi.waitFor(async()=>expect((await s.batches())[0]!.jobs[0]!.status).toBe('cancelled'));
});

test('expiry commits a tombstone before removal, retries a failed removal boundary, and preserves parent report',async()=>{
 let fail=true;const s=await setup({barrier:async()=>{if(fail)throw new Error('CRASH_BARRIER');}});
 s.responses(call({operation:'launch',tasks:[{task:'Research',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'),answer('SYNTHESIS'));
 await s.h.start();await s.receive(1,'Research');s.gate.resolve();
 await vi.waitFor(async()=>expect((await s.batches())[0]?.report.status).toBe('done'));
 const b=(await s.batches())[0]!;s.clock(b.createdAt+CHILD_RETENTION_MS);
 await s.service.cleanup(true);
 expect((await s.service.inspect()).cleanupHeld).toContain(b.id);
 expect((await s.batches())[0]).toMatchObject({tombstone:true,removed:false});
 expect((await stat(s.artifacts.batchDir(b.id))).isDirectory()).toBe(true);
 fail=false;await s.service.cleanup(true);
 expect((await s.batches())[0]).toMatchObject({tombstone:true,removed:true});
 await expect(stat(s.artifacts.batchDir(b.id))).rejects.toMatchObject({code:'ENOENT'});
 expect((await s.batches())[0]!.report.text).toContain('PRIVATE_CHILD_RESULT');
 await s.service.cleanup(true);expect(s.run).toHaveBeenCalledTimes(1);
});

test('cleanup and recovery share control lease and any busy writer preserves every job',async()=>{
 const s=await setup();s.responses(call({operation:'launch',tasks:[{task:'First research',model:s.modelKey,thinking:'off'},{task:'Second research',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'),answer('SYNTHESIS'));
 await s.h.start();await s.receive(1,'Research');s.gate.resolve();await vi.waitFor(async()=>expect((await s.batches())[0]?.report.status).toBe('done'));
 const b=(await s.batches())[0]!,job=b.jobs[1]!;s.clock(b.createdAt+CHILD_RETENTION_MS);
 const control=await s.artifacts.tryBatchLease(b.id);await s.service.cleanup(true);expect((await s.batches())[0]!.tombstone).toBe(false);control!();
 const writer=await openHostStorage(join(s.artifacts.jobDir(b.id,job.id),'store'));
 await s.service.cleanup(true);expect((await s.batches())[0]).toMatchObject({tombstone:true,removed:false});
 expect((await stat(s.artifacts.batchDir(b.id))).isDirectory()).toBe(true);
 for(const child of b.jobs)expect((await stat(s.artifacts.jobDir(b.id,child.id))).isDirectory()).toBe(true);
 await writer.storage.close(context);writer.release();
 await s.service.cleanup(true);expect((await s.batches())[0]!.removed).toBe(true);
});

test('orphan retention holds young or busy stores, survives inventory failure and retries post-removal failure',async()=>{
 const s=await setup(),batchId='a'.repeat(64),jobId='b'.repeat(64),createdAt=Date.now();
 const slash=s.modelKey.indexOf('/');
 const manifest:ChildManifest={version:1,batchId,jobId,launchId:'orphan-fixture',purpose:'Synthetic orphan retention',createdAt,expiresAt:createdAt+CHILD_RETENTION_MS,deadlineAt:createdAt+1000,endCondition:'Expiry',task:'Synthetic research',context:'',model:{provider:s.modelKey.slice(0,slash),modelId:s.modelKey.slice(slash+1)},thinkingLevel:'off',roots:[s.dir],workspaceCwd:s.dir,provider:{credentialPath:'/unused',settingsPath:'/unused',account:'test'}};
 await s.artifacts.prepare(manifest);
 s.clock(manifest.expiresAt-1);await s.service.cleanup(true);
 expect((await s.state())?.orphans[batchId]).toBeUndefined();
 const writer=await openHostStorage(join(s.artifacts.jobDir(batchId,jobId),'store'));
 let writerClosed=false;
 cleanup.push(async()=>{if(!writerClosed){await writer.storage.close(context);writer.release();}});
 s.clock(manifest.expiresAt);await s.service.cleanup(true);
 expect((await s.state())?.orphans[batchId]).toEqual({removed:false});
 expect((await stat(s.artifacts.jobDir(batchId,jobId))).isDirectory()).toBe(true);
 const inventory=vi.spyOn(s.service.artifacts,'listPreparedBatches').mockRejectedValueOnce(new Error('Synthetic inventory failure'));
 await s.service.cleanup(true);inventory.mockRestore();
 expect((await s.service.inspect()).cleanupHeld).toContain('Artifact inventory unavailable');
 expect((await s.state())?.orphans[batchId]).toEqual({removed:false});
 expect((await stat(s.artifacts.jobDir(batchId,jobId))).isDirectory()).toBe(true);
 await writer.storage.close(context);writer.release();writerClosed=true;
 const remove=s.service.artifacts.removeBatch.bind(s.service.artifacts);
 const removal=vi.spyOn(s.service.artifacts,'removeBatch').mockImplementationOnce(async id=>{await remove(id);throw new Error('Synthetic post-remove crash');});
 await s.service.cleanup(true);removal.mockRestore();
 expect((await s.state())?.orphans[batchId]).toEqual({removed:false});
 await expect(stat(s.artifacts.batchDir(batchId))).rejects.toMatchObject({code:'ENOENT'});
 await s.service.cleanup(true);
 expect((await s.state())?.orphans[batchId]).toEqual({removed:true});
 await expect(stat(s.artifacts.batchDir(batchId))).rejects.toMatchObject({code:'ENOENT'});
});

test('child source identity validates shape and changed payloads cannot redirect or move epochs',async()=>{
 const s=await setup();s.responses(answer('HUMAN'),answer('REPORT'));
 await s.h.start();await s.receive(1,'Hello');await vi.waitFor(()=>expect(s.finals).toHaveLength(1));
 const bindings=(await s.h.runtime.harness.snapshot(Bindings,s.h.runtime.root.id,context))!,cid=bindings.epochs['0']!;
 const envelope:SourceEnvelope={instance:'test',principal:'isaac',bot:'123',chatId:42,messageIds:[],originalAt:1,content:'bounded report',proactive:true,child:{batchId:'a'.repeat(64),completionId:'b'.repeat(64)}};
 await expect(accept(s.h.runtime,envelope)).rejects.toThrow('original conversation');
 await acceptChildReport(s.h.runtime,envelope,{conversationId:cid,epoch:0});await admit(s.h.runtime,envelope);
 await expect(acceptChildReport(s.h.runtime,{...envelope,content:'changed'},{conversationId:cid,epoch:0})).rejects.toThrow('conflict');
 await expect(acceptChildReport(s.h.runtime,{...envelope,chatId:100},{conversationId:cid,epoch:0})).rejects.toThrow('authority');
 expect(()=>normalize({...envelope,job:{jobId:'daily',dispatchId:'daily-'+ 'a'.repeat(16),createdAt:new Date(1).toISOString()}})).toThrow();
 expect(sourceKey(envelope)).not.toBe(sourceKey({...envelope,child:undefined,messageIds:[1]}));
});

test('unfinished main child tasks recover stable IDs and original deadline after parent restart',async()=>{
 const s=await setup();s.responses(call({operation:'launch',tasks:[{task:'PRIVATE_RESTART',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'));
 await s.h.start();await s.receive(1,'Research');await vi.waitFor(()=>expect(s.finals).toHaveLength(1));
 const before=(await s.batches())[0]!,manifest=await s.artifacts.readManifest(before.id,before.jobs[0]!.id);
 await s.reopen();s.responses(answer('RECOVERED_SYNTHESIS'));s.gate.resolve();
 await vi.waitFor(async()=>expect((await s.batches())[0]?.report.status).toBe('done'),{timeout:6000});
 await s.h.reconcile();
 const after=(await s.batches())[0]!;
 expect(after.id).toBe(before.id);expect(after.jobs[0]!.taskId).toBe(before.jobs[0]!.taskId);
 expect(await s.artifacts.readManifest(after.id,after.jobs[0]!.id)).toEqual(manifest);
 expect(s.finals.map(x=>x.text)).toEqual(['LAUNCHED','RECOVERED_SYNTHESIS']);
 expect(s.run).toHaveBeenCalledTimes(2);
});

test('faulted child job reports failure only after its writer stops and remains eligible for expiry',async()=>{
 const s=await setup();s.run.mockImplementationOnce(async()=>{await s.gate.promise;throw new Error('Synthetic child orchestration fault');});
 s.responses(call({operation:'launch',tasks:[{task:'Research',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'),answer('FAILED_SYNTHESIS'));
 await s.h.start();await s.receive(1,'Research');await vi.waitFor(()=>expect(s.finals).toHaveLength(1));
 const b=(await s.batches())[0]!,job=b.jobs[0]!;
 const writer=await openHostStorage(join(s.artifacts.jobDir(b.id,job.id),'store'));let writerClosed=false;
 cleanup.push(async()=>{if(!writerClosed){await writer.storage.close(context);writer.release();}});
 const probe=vi.spyOn(s.service.artifacts,'tryWriterLease');
 s.gate.resolve();
 await vi.waitFor(async()=>{const task=await s.h.runtime.harness.getTask(job.taskId!,context);expect(task?.state).toMatchObject({status:'terminal',outcome:{status:'faulted'}});});
 await vi.waitFor(()=>expect(probe).toHaveBeenCalledWith(b.id,job.id));
 expect((await s.batches())[0]!.jobs[0]!.status).toBe('running');
 expect((await s.batches())[0]!.report.status).toBe('pending');
 expect(s.finals.map(x=>x.text)).toEqual(['LAUNCHED']);
 await writer.storage.close(context);writer.release();writerClosed=true;
 await vi.waitFor(async()=>expect((await s.batches())[0]!.report.status).toBe('done'),{timeout:6000});
 const after=(await s.batches())[0]!;
 expect(after.jobs[0]).toMatchObject({status:'failed',finishedAt:expect.any(Number)});
 expect(after.report.text).toContain(`Job ${job.id}: failed`);
 expect(s.finals.map(x=>x.text)).toEqual(['LAUNCHED','FAILED_SYNTHESIS']);
 await s.h.reconcile();expect(s.run).toHaveBeenCalledTimes(1);
 s.clock(b.expiresAt);await s.service.cleanup(true);
 expect((await s.batches())[0]).toMatchObject({tombstone:true,removed:true});
 await expect(stat(s.artifacts.batchDir(b.id))).rejects.toMatchObject({code:'ENOENT'});
});

test('expiry reconciles a faulted child job even when its report task has already faulted',async()=>{
 const s=await setup();s.run.mockImplementationOnce(async()=>{await s.gate.promise;throw new Error('Synthetic child orchestration fault');});
 s.responses(call({operation:'launch',tasks:[{task:'Research',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'));
 await s.h.start();await s.receive(1,'Research');await vi.waitFor(()=>expect(s.finals).toHaveLength(1));
 const b=(await s.batches())[0]!;
 const lease=vi.spyOn(s.service.artifacts,'tryBatchLease').mockRejectedValueOnce(new Error('Synthetic report gate fault'));
 s.gate.resolve();
 await vi.waitFor(async()=>{const task=await s.h.runtime.harness.getTask(b.report.taskId!,context);expect(task?.state).toMatchObject({status:'terminal',outcome:{status:'faulted'}});});
 lease.mockRestore();
 expect((await s.batches())[0]!.jobs[0]!.status).toBe('running');
 const task=await s.h.runtime.harness.getTask(b.jobs[0]!.taskId!,context);
 expect(task?.state).toMatchObject({status:'terminal',outcome:{status:'faulted'}});
 s.clock(b.expiresAt);await s.service.cleanup(true);
 expect((await s.batches())[0]).toMatchObject({tombstone:true,removed:true,report:{status:'retired'},jobs:[{status:'failed'}]});
 await expect(stat(s.artifacts.batchDir(b.id))).rejects.toMatchObject({code:'ENOENT'});
 expect(s.run).toHaveBeenCalledTimes(1);expect(s.finals.map(x=>x.text)).toEqual(['LAUNCHED']);
});

test('failed completion admission expires after the report task stops and does not fail host admission',async()=>{
 const s=await setup();s.responses(call({operation:'launch',tasks:[{task:'Research',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'));
 await s.h.start();await s.receive(1,'Research');await vi.waitFor(()=>expect(s.finals).toHaveLength(1));
 s.h.config.policy=e=>{if(e.child)throw new Error('Completion authority unavailable');};s.gate.resolve();
 await vi.waitFor(async()=>{const b=(await s.batches())[0]!;const task=await s.h.runtime.harness.getTask(b.report.taskId!,context);expect(task?.state.status).toBe('terminal');});
 const b=(await s.batches())[0]!;expect(b.report.status).toBe('injecting');s.clock(b.expiresAt);
 await s.service.cleanup(true);expect((await s.batches())[0]).toMatchObject({tombstone:true,removed:true,report:{status:'retired'}});
 s.responses(answer('STILL_ACCEPTING'));await s.receive(2,'Hello');await vi.waitFor(()=>expect(s.finals.map(x=>x.text)).toContain('STILL_ACCEPTING'));
});

test('expiry waits for an actively admitted synthesis before deleting child artifacts',async()=>{
 const s=await setup(),report=Promise.withResolvers<ReturnType<typeof answer>>();
 s.responses(call({operation:'launch',tasks:[{task:'Research',model:s.modelKey,thinking:'off'}]}),answer('LAUNCHED'),()=>report.promise);
 await s.h.start();await s.receive(1,'Research');s.gate.resolve();
 await vi.waitFor(async()=>expect((await s.batches())[0]?.report.status).toBe('submitted'));
 const b=(await s.batches())[0]!;s.clock(b.expiresAt);await s.service.cleanup(true);
 expect((await s.batches())[0]).toMatchObject({tombstone:false,removed:false});
 report.resolve(answer('SYNTHESIS'));await vi.waitFor(async()=>expect((await s.batches())[0]?.report.status).toBe('done'));
 await s.service.cleanup(true);expect((await s.batches())[0]!.removed).toBe(true);
});
