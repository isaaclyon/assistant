import { Bindings, context, type IngressRuntime } from './ingress.js';
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
