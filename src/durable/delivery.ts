import { defineDoc, type EntryId } from '@earendil-works/pi-durable';
import { Bindings, context, type IngressRuntime, type Target } from './ingress.js';
export type FinalRequest={target:Target;text:string;identity:string};
export type DeliveryReceipt={messageId:number};
export type FinalSender=(request:FinalRequest)=>Promise<DeliveryReceipt>;
export type DeliveryState='sending'|'delivered'|'retryable'|'uncertain'|'suppressed';
type Segment={text:string;status:DeliveryState;receipt?:DeliveryReceipt;retryAt?:number};
type Delivery={target:Target;answerId?:EntryId;segments:Segment[]};
export const Deliveries=defineDoc({kind:'bridge.deliveries',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({items:{} as Record<string,Delivery>})});
export function splitFinal(text:string):string[]{
  const chunks:string[]=[];let chunk='';
  for(const point of text){if(chunk.length+point.length>3500){chunks.push(chunk);chunk='';}chunk+=point;}
  if(chunk)chunks.push(chunk);return chunks;
}
/** Called on one serialized host line; surviving sending intents are never resent. */
export async function reconcileDeliveries(p:IngressRuntime,send:FinalSender,now:()=>number=Date.now) {
  const bindings=await p.harness.snapshot(Bindings,p.root.id,context);
  for(const [key,binding] of Object.entries(bindings?.sources??{})){
    if(binding.deliveryComplete||binding.cancelled)continue;
    const submission=await p.root.commit(tx=>tx.submissionByRequest(binding.conversationId,key),context);
    if(!submission||submission.type!=='input'||(submission.status!=='done'&&submission.status!=='unanswered'))continue;
    if(binding.submissionId!==undefined&&binding.submissionId!==submission.id)throw new Error('Source receipt mismatch');
    if(submission.status==='unanswered'&&submission.reason==='aborted'){await p.root.commit(async tx=>{(await tx.doc(Bindings,p.root.id)).sources[key]!.deliveryComplete=true;},context);continue;}
    const target:Target={chatId:binding.chatId,...(binding.threadId===null?{}:{threadId:binding.threadId})};
    let text='The request could not be completed. Queued messages will continue.';
    if(submission.status==='done'){
      const entry=await p.root.commit(tx=>tx.entry(submission.answer),context);
      if(!entry)throw new Error('Committed answer missing');
      text=(entry.model??[]).flatMap(message=>message.role==='assistant'?message.content.filter(part=>part.type==='text').map(part=>part.text):[]).join('\n');
    }
    const identity=`${submission.status==='done'?`answer:${submission.answer}`:`failure:${submission.id}`}:${binding.chatId}:${binding.threadId??''}`;
    const suppressed=!text.trim()||(binding.proactive&&text.trim()==='NO_REPLY');
    let item=(await p.harness.snapshot(Deliveries,p.root.id,context))?.items[identity];
    if(!item){
      await p.root.commit(async tx=>{(await tx.doc(Deliveries,p.root.id)).items[identity]={target,...(submission.status==='done'?{answerId:submission.answer}:{}),segments:(suppressed?['']:splitFinal(text)).map(text=>({text,status:suppressed?'suppressed':'retryable'}))};},context);
      item=(await p.harness.snapshot(Deliveries,p.root.id,context))!.items[identity]!;
    }
    if(JSON.stringify(item.target)!==JSON.stringify(target))throw new Error('Delivery destination changed');
    for(let index=0;index<item.segments.length;index++){
      const segment=item.segments[index]!;
      if(segment.status==='sending'){
        await p.root.commit(async tx=>{(await tx.doc(Deliveries,p.root.id)).items[identity]!.segments[index]!.status='uncertain';},context);break;
      }
      if(segment.status==='uncertain')break;
      if(segment.status!=='retryable')continue;
      if(segment.retryAt!==undefined&&segment.retryAt>now())break;
      await p.root.commit(async tx=>{(await tx.doc(Deliveries,p.root.id)).items[identity]!.segments[index]!.status='sending';},context);
      let status:DeliveryState='delivered',receipt:DeliveryReceipt|undefined,retryAt:number|undefined;
      try{receipt=await send({target,text:segment.text,identity:`${identity}:${index}`});if(!receipt||!Number.isSafeInteger(receipt.messageId)||receipt.messageId<=0)throw new Error('Missing delivery acknowledgement');}
      catch(error){
        status=typeof error==='object'&&error!==null&&'definitelyNotSent' in error&&error.definitelyNotSent===true?'retryable':'uncertain';receipt=undefined;
        if(status==='retryable'&&typeof error==='object'&&error!==null&&'retryAfterMs' in error){
          const delay=error.retryAfterMs;
          if(typeof delay==='number'&&Number.isSafeInteger(delay)&&delay>0&&delay<=86_400_000)retryAt=now()+delay;
        }
      }
      await p.root.commit(async tx=>{const value=(await tx.doc(Deliveries,p.root.id)).items[identity]!.segments[index]!;value.status=status;if(receipt)value.receipt=receipt;if(retryAt!==undefined)value.retryAt=retryAt;else delete value.retryAt;},context);
      if(status!=='delivered')break;
    }
    await p.root.commit(async tx=>{const item=(await tx.doc(Deliveries,p.root.id)).items[identity]!;if(item.segments.every(s=>s.status==='delivered'||s.status==='suppressed'||s.status==='uncertain'))(await tx.doc(Bindings,p.root.id)).sources[key]!.deliveryComplete=true;},context);
  }
}
