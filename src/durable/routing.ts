import { defineDoc, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { CONVERSATION_ROUTING_IDLE_MS, shouldStartNewConversation } from '../conversation-routing.js';
import type { SemanticJudge } from '../semantic-judge.js';
import { Bindings, context, fingerprint, sourceKey, type IngressRuntime, type SourceEnvelope } from './ingress.js';
import { projectNativeEntry } from './history-native.js';

export type NativeRoute={expectedEpoch:number;rotate:boolean};
type Decision=NativeRoute&{fingerprint:string;reason:'keep'|'new'|'unavailable'};
export const NativeRouting=defineDoc({kind:'bridge.routing',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({decisions:{} as Record<string,Decision>})});
/** The host calls this on its acceptance line. A read-only judgment is recorded
 * before acceptance; the epoch check prevents a delayed judgment rotating a
 * newer manual conversation. Source identity makes transport replay idempotent.
 * This reuses ADR-0033's exact question, threshold and failure fallback. */
export function createNativeConversationRouter(options:{runtime:IngressRuntime;judge:SemanticJudge;onError?:()=>void}) {
 const {runtime}=options;
 return async(envelope:SourceEnvelope):Promise<NativeRoute>=>{
  const state=await runtime.harness.snapshot(Bindings,runtime.root.id,context);
  const epoch=state?.epoch??0,key=sourceKey(envelope),fp=fingerprint(envelope),keep={expectedEpoch:epoch,rotate:false};
  if(envelope.proactive||state?.sources[key])return keep;
  const previous=(await runtime.harness.snapshot(NativeRouting,runtime.root.id,context))?.decisions[key];
  if(previous){
   if(previous.fingerprint!==fp)throw new Error('Routing source payload conflict');
   return previous.expectedEpoch===epoch?{expectedEpoch:epoch,rotate:previous.rotate}:keep;
  }
  let rotate=false,reason:Decision['reason']='keep';
  const cid=state?.epochs[String(epoch)];
  const sources=Object.values(state?.sources??{}).filter(binding=>binding.epoch===epoch&&!binding.proactive&&!binding.cancelled);
  const first=sources[0];
  // Missing/attachment-only context keeps continuity and sends no private paths.
  const live=cid===undefined?undefined:await runtime.harness.snapshot(LiveDoc,cid,context);
  const inbox=cid===undefined?undefined:await runtime.harness.snapshot(InboxDoc,cid,context);
  const busy=!!live?.run||!!live?.compactions?.length||!!inbox?.items.length||runtime.store.inbox.pending().length>0;
  if(!busy&&cid!==undefined&&first&&!(first.envelope.attachments?.length)&&!(envelope.attachments?.length)&&state!.lastHumanAt>0&&envelope.originalAt-state!.lastHumanAt>CONVERSATION_ROUTING_IDLE_MS){
   try{
    const entries=await runtime.store.storage.scanEntries({conversationId:cid,order:'descending'},256,undefined,context);
    const branch:unknown[]=[{type:'message',message:{role:'user',content:`[telegram] ${first.envelope.content}`}}];
    let human=false;
    for(const entry of [...entries.items].reverse()){
     if(entry.kind==='bridge.source'){
      const data=entry.data as {sourceId?:string}|undefined,binding=data?.sourceId?state!.sources[data.sourceId]:undefined;
      human=!!binding&&!binding.proactive&&!binding.cancelled&&!(binding.envelope.attachments?.length);
      if(human)branch.push({type:'message',message:{role:'user',content:`[telegram] ${binding!.envelope.content}`}});
     }else if(human&&entry.kind==='pi.assistant'){
      const evidence=projectNativeEntry({id:entry.id as unknown as number,conversationId:cid as unknown as number,kind:entry.kind,model:entry.model,data:entry.data});
      if(evidence?.role==='assistant')branch.push({type:'message',message:{role:'assistant',content:evidence.text}});
     }
    }
    rotate=await shouldStartNewConversation(branch,`[telegram] ${envelope.content}`,options.judge);reason=rotate?'new':'keep';
   }catch{reason='unavailable';try{options.onError?.();}catch{/* Diagnostic failure cannot change continuity. */}}
  }
  await runtime.root.commit(async tx=>{
   const doc=await tx.doc(NativeRouting,runtime.root.id),bindings=await tx.doc(Bindings,runtime.root.id);
   if(bindings.epoch!==epoch)throw new Error('Conversation changed during routing');
   const prior=doc.decisions[key];if(prior&&prior.fingerprint!==fp)throw new Error('Routing source payload conflict');
   doc.decisions[key]??={fingerprint:fp,expectedEpoch:epoch,rotate,reason};
  },context);
  return {expectedEpoch:epoch,rotate};
 };
}
