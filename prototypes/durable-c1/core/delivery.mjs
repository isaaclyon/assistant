// Prototype-only reconciliation policy; the sender reports only definite pre-send failure specially.
import { defineDoc } from '@earendil-works/pi-durable';
import { context } from './runtime.mjs';
import { Bindings } from './ingress.mjs';
// Recover solely from durable source bindings, including a lost admission receipt.
export async function discoverDeliveries(p,send){
  const state=await p.harness.snapshot(Bindings,p.root.id,context), outcomes=[];
  for(const [sourceId,binding] of Object.entries(state?.sources??{})){
    const submission=await p.root.commit(tx=>tx.submissionByRequest(binding.conversationId,sourceId),context);
    if(!submission || submission.type!=='input' || submission.status!=='done')continue;
    if(binding.submissionId!==undefined && binding.submissionId!==submission.id)throw new Error('Source receipt mismatch');
    const target={chatId:binding.chatId,...(binding.threadId===null?{}:{threadId:binding.threadId})};
    outcomes.push({sourceId,submissionId:submission.id,status:await deliver(p,submission.id,target,send)});
  }
  return outcomes;
}
export const Deliveries=defineDoc({kind:'probe.deliveries',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({items:/** @type {Record<string, {status:string,target:{chatId:number,threadId?:number},answerId:number,receipt?:{messageId:number}}>} */({})})});
export async function deliver(p,submissionId,target,send){
  const submission=await p.harness.submission(submissionId,context);const settled=await submission.status(context);
  if(settled.type!=='input'||settled.status!=='done')throw new Error('No committed answer');
  const key=`answer:${submissionId}`;
  const intent=await p.root.commit(async tx=>{
    const items=(await tx.doc(Deliveries,p.root.id)).items;
    if(items[key]){
      if(JSON.stringify(items[key].target)!==JSON.stringify(target))throw new Error('Destination changed');
      if(items[key].status==='sending')items[key].status='uncertain';
      if(items[key].status!=='retryable')return {attempt:false,status:items[key].status};
    }
    items[key]={status:'sending',target,answerId:settled.answer};return {attempt:true};
  },context);
  if(!intent.attempt)return intent.status;
  let status,receipt;
  try{receipt=await send({target,answerId:settled.answer});if(!receipt || typeof receipt.messageId!=='number')throw new Error('Missing acknowledgement');status='delivered';}
  catch(error){status=error?.definitelyNotSent===true?'retryable':'uncertain';}
  await p.root.commit(async tx=>{const item=(await tx.doc(Deliveries,p.root.id)).items[key];item.status=status;if(receipt!==undefined)item.receipt=receipt;},context);
  return status;
}
