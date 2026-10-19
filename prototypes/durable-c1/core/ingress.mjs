// Prototype-only source binding and cross-store admission protocol.
import { createHash } from 'node:crypto';
import { defineDoc, configure } from '@earendil-works/pi-durable';
import { context } from './runtime.mjs';
export const Bindings=defineDoc({kind:'probe.sources',version:1,scope:'conversation',history:'latest',fork:'initial',
  initial:()=>({epoch:0,epochs:/** @type {Record<string, number>} */({}),sources:/** @type {Record<string, {conversationId:number,epoch:number,fingerprint:string,chatId:number,threadId:number|null,originalAt:number,submissionId?:number}>} */({})})});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceKey=e=>hash([e.instance,e.bot,e.chatId,e.threadId??null,e.messageIds]);
export const fingerprint=e=>hash(e);
export async function reserveNextEpoch(p){await p.root.commit(async tx=>{(await tx.doc(Bindings,p.root.id)).epoch++;},context);}
export async function accept(p,inbox,envelope,ack=()=>{}){
  const key=sourceKey(envelope), fp=fingerprint(envelope);
  const binding=await p.root.commit(async tx=>{
    const state=await tx.doc(Bindings,p.root.id);
    if(Object.hasOwn(state.sources,key)){
      if(state.sources[key].fingerprint!==fp)throw new Error('Source payload conflict');
      // Transaction documents are proxies; project this primitive-valued record.
      return {...state.sources[key]};
    }
    let conversationId=state.epochs[state.epoch];
    if(conversationId===undefined){
      const conversation=await tx.createConversation({ownership:{kind:'ownerless'}});
      await configure(tx,conversation.id,p.agent);
      conversationId=conversation.id;state.epochs[state.epoch]=conversationId;
    }
    const value={conversationId,epoch:state.epoch,fingerprint:fp,chatId:envelope.chatId,threadId:envelope.threadId??null,originalAt:envelope.originalAt};
    state.sources[key]=value;return value;
  },context);
  inbox.persist(key,JSON.stringify(envelope),envelope.originalAt);
  await ack();return {key,binding};
}
export async function admit(p,inbox,envelope,{beforeReceipt}={}){
  const key=sourceKey(envelope),state=await p.harness.snapshot(Bindings,p.root.id,context),binding=state.sources[key];
  if(!binding || binding.fingerprint!==fingerprint(envelope))throw new Error('Source payload conflict or missing binding');
  const conversation=await p.harness.conversation(binding.conversationId,context);
  if(!conversation)throw new Error('Bound conversation missing');
  const submission=await conversation.submit({type:'input',whenBusy:'followUp',requestId:key,content:envelope.content,
    entry:{kind:'bridge.source',data:{sourceId:key,originalAt:binding.originalAt,chatId:binding.chatId,threadId:binding.threadId,attachments:envelope.attachments??[]}}},context);
  await beforeReceipt?.(submission);
  await p.root.commit(async tx=>{(await tx.doc(Bindings,p.root.id)).sources[key].submissionId=submission.id;},context);
  inbox.remove(key);return {conversation,submission,binding};
}
