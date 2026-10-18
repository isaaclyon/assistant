import { createHash } from 'node:crypto';
import { Type, StringEnum, getSupportedThinkingLevels, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { defineDoc, defineTask, defineTool, type ConversationId, type TaskId, type ToolExecutionApi, type Tx } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { NativeConfig } from './config.js';
import type { DurableHost } from './host.js';
import type { createNativeProvider } from './provider.js';
import { Bindings, acceptChildReport, admit, context, sourceKey, type SourceEnvelope } from './ingress.js';
import { ChildArtifacts } from './child-artifacts.js';
import { createChildSupervisor } from './child-supervisor.js';
import { CHILD_RETENTION_MS, CHILD_TIMEOUT_MS, boundedChildText, type ChildManifest, type ChildOutcome } from './child-contracts.js';
import { textToolResult, type NativeBundle } from './registry.js';

const hash=(...parts:unknown[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
type JobStatus='queued'|'running'|ChildOutcome['status'];
type ChildJob={id:string;launchId:string;taskId:TaskId|null;status:JobStatus;cancelRequested:boolean;finishedAt:number|null};
type Origin={conversationId:ConversationId;epoch:number;principal:string;chatId:number;threadId:number|null;instance:string;bot:string};
export type ChildBatch={id:string;createdAt:number;expiresAt:number;origin:Origin;jobs:ChildJob[];report:{taskId:TaskId|null;status:'pending'|'injecting'|'submitted'|'done'|'retired';text:string|null;sourceId:string|null};tombstone:boolean;removed:boolean};
export const NativeChildren=defineDoc({kind:'bridge.background-children',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({batches:{} as Record<string,ChildBatch>,orphans:{} as Record<string,{removed:boolean}>})});
const terminal=(job:ChildJob)=>job.status!=='queued'&&job.status!=='running';
const settled=()=>({status:'terminal' as const,outcome:{status:'completed' as const,result:null}});
const ModelSchema=Type.String({minLength:1,maxLength:200});
const ThinkingSchema=StringEnum(['off','minimal','low','medium','high','xhigh','max'] as const);
const TaskSchema=Type.Object({task:Type.String({minLength:1,maxLength:16_384}),context:Type.Optional(Type.String({maxLength:32_768})),model:Type.Optional(ModelSchema),thinking:Type.Optional(ThinkingSchema)});
const Parameters=Type.Object({operation:StringEnum(['launch','list','inspect','cancel','collect'] as const),tasks:Type.Optional(Type.Array(TaskSchema,{minItems:1})),model:Type.Optional(ModelSchema),thinking:Type.Optional(ThinkingSchema),status:Type.Optional(StringEnum(['active','terminal'] as const)),job_id:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'})),job_ids:Type.Optional(Type.Array(Type.String({pattern:'^[a-f0-9]{64}$'}),{minItems:1,maxItems:100})),batch_id:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'}))});
type Args={operation:'launch'|'list'|'inspect'|'cancel'|'collect';tasks?:{task:string;context?:string;model?:string;thinking?:ModelThinkingLevel}[];model?:string;thinking?:ModelThinkingLevel;status?:'active'|'terminal';job_id?:string;job_ids?:string[];batch_id?:string};
export function createNativeChildren(options:{config:NativeConfig;host:()=>DurableHost;provider:Awaited<ReturnType<typeof createNativeProvider>>;supervisor?:ReturnType<typeof createChildSupervisor>;now?:()=>number;onTombstone?:(batchId:string)=>Promise<void>}) {
 const now=options.now??Date.now,artifacts=new ChildArtifacts(options.config.stateDir);
 const supervisor=options.supervisor??createChildSupervisor({stateDir:options.config.stateDir,now});
 let closed=false,lastCleanup=-Infinity;
 let cleanupHeld:string[]=[];
 const host=options.host;
 const state=()=>host().runtime.harness.snapshot(NativeChildren,host().runtime.root.id,context);
 const batch=async(id:string)=>(await state())?.batches[id];
 const change=async<T>(id:string,work:(value:ChildBatch,tx:Tx)=>Promise<T>|T)=>host().runtime.root.commit(async tx=>{
  const value=(await tx.doc(NativeChildren,host().runtime.root.id)).batches[id];if(!value)throw new Error('Unknown child batch');return work(value,tx);
 },context);
 async function origin(tx:Tx,cid:ConversationId):Promise<Origin>{
  const value=await tx.doc(Bindings,host().runtime.root.id);
  if(value.epochs[String(value.epoch)]!==cid)throw new Error('Child launch requires current conversation authority');
  const sources=Object.values(value.sources).filter(s=>s.conversationId===cid&&!s.cancelled);
  if(!sources.length||sources.some(s=>s.principal!==options.config.principal||s.chatId!==options.config.transport.allowedUserId||s.threadId!==null||s.envelope.instance!==options.config.instanceId||s.envelope.bot!==String(options.config.transport.botId)))throw new Error('Child launch authority rejected');
  return {conversationId:cid,epoch:value.epoch,principal:options.config.principal,chatId:options.config.transport.allowedUserId,threadId:null,instance:options.config.instanceId,bot:String(options.config.transport.botId)};
 }
 // The caller holds the batch control lease. A settled native task cannot resume;
 // reconcile its missing bridge outcome only after proving the writer has stopped.
 async function reconcileStoppedJobs(id:string){
  if(supervisor.active(id))return;
  const writers:(()=>void)[]=[];
  try{
   await change(id,async(b,tx)=>{
    if(b.tombstone)return;
    for(const job of b.jobs){
     if(terminal(job)||!job.taskId)continue;
     const task=await tx.task(job.taskId);if(task?.state.status!=='terminal')continue;
     const writer=await artifacts.tryWriterLease(id,job.id);if(!writer)continue;
     writers.push(writer);job.status='failed';job.finishedAt=now();
    }
   });
  }finally{for(const writer of writers.reverse())writer();}
 }
 const jobTask=defineTask<{batchId:string;jobId:string},{phase:'run'},null>({name:'bridge.child-job',version:1,initial:()=>({phase:'run'}),phases:{run:async(running,runtime,ctx)=>{
  const {batchId,jobId}=running.input;
  const selected=await batch(batchId),job=selected?.jobs.find(j=>j.id===jobId);
  if(!selected||!job||selected.tombstone||terminal(job)){await runtime.commit(()=>settled(),ctx);return;}
  if(job.taskId!==runtime.taskId||selected.origin.conversationId!==runtime.conversationId)throw new Error('Child task identity conflict');
  await change(batchId,b=>{b.jobs.find(j=>j.id===jobId)!.status='running';});
  const outcome=await supervisor.run(batchId,jobId,{signal:runtime.signal,canRun:async()=>{
   const b=await batch(batchId);return !closed&&!!b&&!b.tombstone&&b.jobs.some(j=>j.id===jobId&&j.taskId===runtime.taskId&&!terminal(j));
  },isCancelled:async()=>!!(await batch(batchId))?.jobs.find(j=>j.id===jobId)?.cancelRequested});
  runtime.signal.throwIfAborted();
  if(!outcome)throw new Error('Child execution held for verified recovery');
  await runtime.commit(async tx=>{
   const b=(await tx.doc(NativeChildren,host().runtime.root.id)).batches[batchId]!;
   if(!b.tombstone){const j=b.jobs.find(j=>j.id===jobId)!;j.status=outcome.status;j.finishedAt=outcome.finishedAt;}
   return settled();
  },ctx);
 }},abort:async(running,runtime,ctx)=>{
  await change(running.input.batchId,b=>{const j=b.jobs.find(j=>j.id===running.input.jobId);if(j&&!terminal(j))j.cancelRequested=true;});
  const outcome=await supervisor.run(running.input.batchId,running.input.jobId,{signal:runtime.signal,canRun:async()=>!(await batch(running.input.batchId))?.tombstone,isCancelled:async()=>true});
  if(!outcome)throw new Error('Child cancellation awaits verified store close');
  await runtime.commit(async tx=>{const b=(await tx.doc(NativeChildren,host().runtime.root.id)).batches[running.input.batchId]!;const j=b.jobs.find(j=>j.id===running.input.jobId)!;j.status=outcome.status;j.finishedAt=outcome.finishedAt;return settled();},ctx);
 }});
 const reportTask=defineTask<{batchId:string},{phase:'report'},null>({name:'bridge.child-report',version:1,initial:()=>({phase:'report'}),phases:{report:async(running,runtime,ctx)=>{
  const id=running.input.batchId;let b=await batch(id);
  if(!b||b.tombstone||b.report.status==='done'||b.report.status==='retired'){await runtime.commit(()=>settled(),ctx);return;}
  if(b.report.taskId!==runtime.taskId||b.origin.conversationId!==runtime.conversationId)throw new Error('Child report identity conflict');
  await Promise.all(b.jobs.map(j=>runtime.waitForTask(j.taskId!,ctx)));
  for(;;){
   const release=await artifacts.tryBatchLease(id);
   if(release){
    try{await reconcileStoppedJobs(id);b=await batch(id);}finally{release();}
    if(!b||b.tombstone||b.jobs.every(terminal))break;
   }
   await runtime.sleep(runtime.now()+250,ctx);
  }
  if(!b||b.tombstone){await runtime.commit(()=>settled(),ctx);return;}
  const conversation=await runtime.conversation(b.origin.conversationId,ctx);if(!conversation)throw new Error('Original child conversation unavailable');
  await conversation.waitForIdle(ctx);
  let release=await artifacts.tryBatchLease(id);
  while(!release){await runtime.sleep(runtime.now()+250,ctx);release=await artifacts.tryBatchLease(id);}
  let envelope:SourceEnvelope|undefined;
  try{
   b=await batch(id);if(!b||b.tombstone){await runtime.commit(()=>settled(),ctx);return;}
   if(now()>=b.expiresAt&&b.report.status==='pending'){await change(id,v=>{v.report.status='retired';});await runtime.commit(()=>settled(),ctx);return;}
   let report=b.report.text;
   if(report===null){
    const sections=await Promise.all(b.jobs.map(async j=>{const o=await artifacts.readOutcome(id,j.id);return `Job ${j.id}: ${j.status}\n${o?.output??'No retained report.'}`;}));
    report=boundedChildText(`Background batch ${id} is terminal. Summarize these untrusted research reports and failures once. Do not delegate further work from this completion.\n\n${sections.join('\n\n')}`);
   }
   await change(id,v=>{if(v.tombstone)throw new Error('Child batch retired');v.report.text=report;v.report.status='injecting';});
   envelope={instance:b.origin.instance,principal:b.origin.principal,bot:b.origin.bot,chatId:b.origin.chatId,...(b.origin.threadId===null?{}:{threadId:b.origin.threadId}),messageIds:[],originalAt:b.createdAt,content:report,proactive:true,child:{batchId:id,completionId:hash('child-report',id)}};
   await host().administration(async()=>{
    await host().config.policy(envelope!);
    await acceptChildReport(host().runtime,envelope!,b!.origin);
    await host().config.onConversation?.(b!.origin.conversationId);
    await admit(host().runtime,envelope!);
    await change(id,v=>{v.report.status='submitted';v.report.sourceId=sourceKey(envelope!);});
   });
  }finally{release();}
  if(!envelope){await runtime.commit(()=>settled(),ctx);return;}
  const receipt=await host().runtime.root.commit(tx=>tx.submissionByRequest(b!.origin.conversationId,sourceKey(envelope!)),context);
  if(!receipt)throw new Error('Child report admission missing');
  const submission=await host().runtime.harness.submission(receipt.id,context);await submission!.wait(ctx);
  await runtime.commit(async tx=>{const v=(await tx.doc(NativeChildren,host().runtime.root.id)).batches[id]!;v.report.status='done';return settled();},ctx);
 }},abort:async(running,runtime,ctx)=>{await runtime.commit(async tx=>{const b=(await tx.doc(NativeChildren,host().runtime.root.id)).batches[running.input.batchId];if(b)b.report.status='retired';return settled();},ctx);}});
 async function launch(args:Args,api:ToolExecutionApi,ctx:Context){
  if(!args.tasks?.length)throw new Error('Launch requires explicitly listed independent tasks');
  const createdAt=await api.memo('child.created-at',now(),ctx),id=hash('child-batch',api.taskId);
  const captured=await api.commit(tx=>origin(tx,api.conversationId),ctx);
  const manifests:ChildManifest[]=args.tasks.map((task,index)=>{
   const key=task.model??args.model??'openai-codex/gpt-6-luna',slash=key.indexOf('/');
   const model=options.provider.models.getModel(key.slice(0,slash),key.slice(slash+1));
   const thinking=task.thinking??args.thinking??'high';
   if(slash<1||!model||model.provider!==options.provider.provider.id||!getSupportedThinkingLevels(model).includes(thinking))throw new Error('Child model or thinking level is outside the selected provider configuration');
   return {version:1,batchId:id,jobId:hash(id,index),launchId:hash('child-launch',id,index),purpose:'Independent read-only background research',createdAt,expiresAt:createdAt+CHILD_RETENTION_MS,deadlineAt:createdAt+CHILD_TIMEOUT_MS,endCondition:'Terminal outcome followed by batch expiry',task:task.task,context:task.context??'',model:{provider:model.provider,modelId:model.id},thinkingLevel:thinking,roots:[options.config.workspaceCwd,options.config.resourceRoot],workspaceCwd:options.config.workspaceCwd,provider:{credentialPath:options.config.credentialPath,settingsPath:options.config.settingsPath,account:options.config.account}};
  });
  const release=await artifacts.tryBatchLease(id);if(!release)throw new Error('Child batch control is busy; inspect before retrying');
  try{
   if((await state())?.batches[id]?.tombstone||(await state())?.orphans[id])throw new Error('Child batch has expired');
   for(const m of manifests)await artifacts.prepare(m);
   await api.commit(async tx=>{
    const doc=await tx.doc(NativeChildren,host().runtime.root.id);
    if(doc.batches[id])return;
    if(doc.orphans[id])throw new Error('Child batch has expired');
    await origin(tx,api.conversationId);
    const b:ChildBatch={id,createdAt,expiresAt:createdAt+CHILD_RETENTION_MS,origin:captured,jobs:[],report:{taskId:null,status:'pending',text:null,sourceId:null},tombstone:false,removed:false};
    for(const manifest of manifests){const taskId=await tx.createTask(jobTask,{batchId:id,jobId:manifest.jobId},{ownership:{kind:'conversation'},conversationId:api.conversationId,background:true,abandonOnRestart:false});b.jobs.push({id:manifest.jobId,launchId:manifest.launchId,taskId,status:'queued',cancelRequested:false,finishedAt:null});}
    b.report.taskId=await tx.createTask(reportTask,{batchId:id},{ownership:{kind:'conversation'},conversationId:api.conversationId,background:true,abandonOnRestart:false});
    doc.batches[id]=b;
   },ctx);
  }finally{release();}
  return {batchId:id,jobIds:manifests.map(m=>m.jobId)};
 }
 async function manage(args:Args,api:ToolExecutionApi,ctx:Context){
  if(closed)throw new Error('Child service is closed');
  if(args.operation==='launch')return launch(args,api,ctx);
  const current=await api.commit(tx=>origin(tx,api.conversationId),ctx);
  const all=Object.values((await state())?.batches??{}).filter(b=>b.origin.instance===current.instance&&b.origin.principal===current.principal&&b.origin.bot===current.bot&&b.origin.chatId===current.chatId&&b.origin.threadId===current.threadId);
  const selected=all.filter(b=>(!args.batch_id||b.id===args.batch_id)&&(!args.job_id||b.jobs.some(j=>j.id===args.job_id))&&(!args.job_ids||b.jobs.some(j=>args.job_ids!.includes(j.id))));
  if(args.operation!=='list'&&!args.batch_id&&!args.job_id&&!args.job_ids)throw new Error('Select a batch or job');
  if(args.operation!=='list'&&!selected.length)throw new Error('Child batch/job is unavailable for this instance and target');
  const jobs=(b:ChildBatch)=>b.jobs.filter(j=>(!args.job_id||j.id===args.job_id)&&(!args.job_ids||args.job_ids.includes(j.id)));
  if(args.operation==='cancel'){
   for(const b of selected)await change(b.id,value=>{for(const job of value.jobs)if(jobs(b).some(j=>j.id===job.id)&&!terminal(job))job.cancelRequested=true;});
   return {status:'cancellation_requested',batchIds:selected.map(b=>b.id)};
  }
  if(args.operation==='list')return all.filter(b=>!args.status||(args.status==='terminal')===b.jobs.every(terminal)).map(b=>({batchId:b.id,createdAt:b.createdAt,expiresAt:b.expiresAt,retired:b.tombstone,report:b.report.status,jobs:b.jobs.map(j=>({jobId:j.id,status:j.status,cancelRequested:j.cancelRequested}))}));
  const result=[];
  for(const b of selected){
   if(b.tombstone){result.push({batchId:b.id,retired:true});continue;}
   for(const j of jobs(b)){
    const report=await artifacts.readOutcome(b.id,j.id);
    result.push({batchId:b.id,jobId:j.id,status:j.status,output:report?.output??(args.operation==='inspect'?await artifacts.readPartial(b.id,j.id):undefined)??'',untrusted:true});
   }
  }
  return result;
 }
 const reportKey=(b:ChildBatch)=>b.report.sourceId??hash(b.origin.instance,b.origin.principal,b.origin.bot,'child',hash('child-report',b.id));
 async function reportBusy(tx:Tx,b:ChildBatch){
  const key=reportKey(b),bindings=await tx.doc(Bindings,host().runtime.root.id),binding=bindings.sources[key];
  const receipt=await tx.submissionByRequest(b.origin.conversationId,key);
  // A failed/aborted report task does not stop its separately admitted synthesis.
  if(receipt&&receipt.type==='input'&&receipt.status!=='done'&&receipt.status!=='unanswered')return true;
  if(binding&&!binding.cancelled&&!receipt)return true; // accepted front buffer still awaits admission
  if(['injecting','submitted'].includes(b.report.status)&&b.report.taskId){const task=await tx.task(b.report.taskId);if(task&&task.state.status!=='terminal')return true;}
  return false;
 }
 async function cleanup(force=false){
  if(closed||(!force&&now()-lastCleanup<3_600_000))return;
  lastCleanup=now();
  cleanupHeld=[];
  const saved=await state();
  const candidates=new Map(Object.values(saved?.batches??{}).filter(b=>now()>=b.expiresAt&&!b.removed).map(b=>[b.id,b.jobs.map(j=>j.id)]));
  let prepared:Awaited<ReturnType<ChildArtifacts['listPreparedBatches']>>|undefined;
  try{prepared=await artifacts.listPreparedBatches();for(const orphan of prepared)if(!saved?.batches[orphan.batchId]&&now()>=orphan.createdAt+CHILD_RETENTION_MS)candidates.set(orphan.batchId,orphan.jobIds);}catch{cleanupHeld.push('Artifact inventory unavailable');}
  if(prepared)for(const id of Object.keys(saved?.orphans??{}))if(!saved?.orphans[id]?.removed&&!candidates.has(id))candidates.set(id,prepared.find(p=>p.batchId===id)?.jobIds??[]);
  for(const [id,jobIds] of candidates){
   let release:(()=>void)|undefined;
   const writers:(()=>void)[]=[];
   try{
    release=await artifacts.tryBatchLease(id);if(!release)continue;
    if(supervisor.active(id))continue;
    if((await batch(id)))await reconcileStoppedJobs(id);
    const b=await batch(id);
    if(b&&(b.removed||now()<b.expiresAt||!b.jobs.every(terminal)))continue;
    await host().runtime.root.commit(async tx=>{
     const doc=await tx.doc(NativeChildren,host().runtime.root.id),value=doc.batches[id];
     if(value){if(!value.jobs.every(terminal)||await reportBusy(tx,value))return false;value.tombstone=true;if(value.report.status!=='done')value.report.status='retired';}
     else doc.orphans[id]??={removed:false};
     return true;
    },context).then(retiring=>{if(!retiring)throw new Error('Child report is still active');});
    await options.onTombstone?.(id);
    let busy=false;
    for(const jobId of jobIds){const writer=await artifacts.tryWriterLease(id,jobId);if(!writer){busy=true;break;}writers.push(writer);}
    if(busy)continue;
    await artifacts.removeBatch(id);
    await host().runtime.root.commit(async tx=>{const doc=await tx.doc(NativeChildren,host().runtime.root.id);if(doc.batches[id])doc.batches[id]!.removed=true;else doc.orphans[id]!.removed=true;},context);
   }catch{cleanupHeld.push(id);}finally{for(const writer of writers.reverse())writer();release?.();}
  }
  if(cleanupHeld.length)lastCleanup=now()-3_540_000;
 }
 async function inspect(){const value=await state(),batches=Object.values(value?.batches??{});return {batches:batches.length,activeJobs:batches.flatMap(b=>b.jobs).filter(j=>!terminal(j)).length,retiring:batches.filter(b=>b.tombstone&&!b.removed).length,removed:batches.filter(b=>b.removed).length,cleanupHeld:cleanupHeld.slice(0,50)};}
 return {artifacts,jobTask,reportTask,cleanup,inspect,async close(){closed=true;await supervisor.close();},bundle:():NativeBundle=>({name:'background-children',version:1,tools:[{version:1,tool:defineTool({name:'background_subagents',description:'Launch explicitly listed independent, bounded read-only research jobs; returns immediately. One target-bound synthesis follows completion. Manage list, inspect, cancel and collect.',parameters:Parameters,replay:'unsafe',execute:async(args,api,ctx)=>{try{return textToolResult(boundedChildText(JSON.stringify(await manage(args as Args,api,ctx))));}catch(error){if(ctx.abortSignal?.aborted)throw error;return textToolResult(error instanceof Error?error.message:'Child operation failed',true);}}})}],contributions:{tasks:[jobTask,reportTask]},async close(){}})};
}
