import { Bindings, context, fingerprint, normalize, sourceKey, type IngressRuntime } from './ingress.js';
import { Deliveries } from './delivery.js';
export async function wakeFailedQueues(p:IngressRuntime){
  const state=await p.harness.snapshot(Bindings,p.root.id,context);
  for(const [key,binding] of Object.entries(state?.sources??{})){
    if(binding.deliveryComplete||binding.wakeComplete||binding.cancelled)continue;
    const record=await p.root.commit(tx=>tx.submissionByRequest(binding.conversationId,key),context);
    if(record?.type!=='input'||record.status!=='unanswered')continue;
    if(await p.root.commit(tx=>tx.submissionByRequest(binding.conversationId,`wake:${record.id}`),context))continue;
    const conversation=await p.harness.conversation(binding.conversationId,context);
    if(!conversation)throw new Error('Bound conversation missing');
    await conversation.submit({type:'write',requestId:`wake:${record.id}`,entry:{kind:'bridge.queue-wake',model:[],data:{failedSubmissionId:record.id}}},context);
    await p.root.commit(async tx=>{(await tx.doc(Bindings,p.root.id)).sources[key]!.wakeComplete=true;},context);
  }
}
export async function inspectRecovery(p:IngressRuntime){
  const inspection=await p.harness.inspect(context),deliveries=await p.harness.snapshot(Deliveries,p.root.id,context);
  return {inspection,pendingInbox:p.store.inbox.pending().length,uncertain:Object.entries(deliveries?.items??{}).filter(([,item])=>item.segments.some(s=>s.status==='sending'||s.status==='uncertain')).map(([identity])=>identity)};
}

/** Raised before any transport or task execution when a pending inbox row has no native binding. */
export class UnboundInboxError extends Error {
  constructor(readonly reasons:Record<'unparseable'|'unrecognized-shape'|'unbound'|'changed',number>){
    super(`Pending inbox holds ${Object.values(reasons).reduce((a,b)=>a+b,0)} row(s) not bound to the native source ledger (${Object.entries(reasons).filter(([,n])=>n).map(([k,n])=>`${k}: ${n}`).join(', ')}). Rows are preserved unchanged and nothing started. Reconcile them with the C6 migration tool before starting this instance.`);
  }
}
/** Read-only and content-free. Native acceptance commits its binding before the inbox row, so a
 * row without a matching binding is legacy or unknown and may already have been dispatched. */
export async function assertInboxBound(p:IngressRuntime){
  const rows=p.store.inbox.pending();
  if(!rows.length)return;
  const state=await p.harness.snapshot(Bindings,p.root.id,context);
  const reasons={unparseable:0,'unrecognized-shape':0,unbound:0,changed:0};
  for(const row of rows){
    let envelope;
    try{envelope=normalize(JSON.parse(row.payload));}catch{reasons[/^\s*[{[]/.test(row.payload)?'unrecognized-shape':'unparseable']++;continue;}
    if(sourceKey(envelope)!==row.id){reasons['unrecognized-shape']++;continue;}
    const binding=state?.sources[row.id];
    if(!binding)reasons.unbound++;else if(binding.fingerprint!==fingerprint(envelope))reasons.changed++;
  }
  if(Object.values(reasons).some(n=>n))throw new UnboundInboxError(reasons);
}

/** Dry-runs each pending task migration on a detached copy. The Harness reports a throwing `migrate`
 * as ready and fails it only at reservation, which is after transport start. Content-free errors. */
export function assertTaskMigrationsRunnable(inspection:Awaited<ReturnType<IngressRuntime['harness']['inspect']>>,registry:{task(name:string):unknown}){
  for(const task of inspection.tasks){
    if(task.state.kind!=='ready'||!task.state.migrates)continue;
    const migrate=(registry.task(task.record.kind) as {definition:{migrate?(input:unknown,checkpoint:unknown,from:number):unknown}}|undefined)?.definition.migrate;
    if(!migrate)throw new Error(`Recovery blocked: task ${task.record.id} has no migration`);
    const state=task.record.state,checkpoint=(state as {checkpoint?:unknown}).checkpoint;
    try{migrate(structuredClone(task.record.input),structuredClone(checkpoint),task.record.version);}
    catch{throw new Error(`Recovery blocked: migration of task ${task.record.id} (${task.record.kind}) failed`);}
  }
}
