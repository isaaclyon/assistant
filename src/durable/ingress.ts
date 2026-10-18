import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { configure, defineDoc, type AgentChange, type Conversation, type ConversationId, type Harness, type SubmissionId, type Tx } from '@earendil-works/pi-durable';
import type { HostStorage } from './storage.js';
export { context };
export type Target = {chatId:number; threadId?:number};
export type JobSource = {dispatchId:string;jobId:string;jobType?:'cron'|'at'|'heartbeat'|'webhook';createdAt:string};
export type SourceEnvelope = Target & {instance:string;principal:string;bot:string;messageIds:number[];originalAt:number;content:string;proactive?:boolean;attachments?:JsonValue[];job?:JobSource};
export type Binding = {conversationId:ConversationId;epoch:number;fingerprint:string;chatId:number;threadId:number|null;originalAt:number;principal:string;proactive:boolean;envelope:SourceEnvelope;submissionId?:SubmissionId;cancelled?:boolean;deliveryComplete?:boolean;wakeComplete?:boolean};
export const Bindings = defineDoc({kind:'bridge.sources',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({epoch:0,lastHumanAt:0,epochs:{} as Record<string,ConversationId>,sources:{} as Record<string,Binding>,rotations:{} as Record<string,number>})});
// Canonical field order also makes inbox bytes stable across equivalent transport objects.
export function normalize(e:SourceEnvelope):SourceEnvelope {
  if (!e.instance || !e.principal || !e.bot || !Number.isSafeInteger(e.chatId) || !Number.isSafeInteger(e.originalAt) || e.originalAt<0 || !Array.isArray(e.messageIds) || (!e.messageIds.length&&!e.job) || e.messageIds.some(id=>!Number.isSafeInteger(id)) || typeof e.content!=='string' || (e.threadId!==undefined&&!Number.isSafeInteger(e.threadId))) throw new Error('Invalid source envelope');
  if(e.job!==undefined){
    const job=e.job;
    if(!job||typeof job!=='object'||Array.isArray(job)||Object.keys(job).some(k=>!['dispatchId','jobId','jobType','createdAt'].includes(k))||typeof job.jobId!=='string'||!/^[a-z0-9-]{1,64}$/.test(job.jobId)||typeof job.dispatchId!=='string'||!new RegExp(`^${job.jobId}-[a-f0-9]{16}(?:[a-f0-9]{48})?$`).test(job.dispatchId)||typeof job.createdAt!=='string'||!Number.isFinite(Date.parse(job.createdAt))||Date.parse(job.createdAt)!==e.originalAt||(job.jobType!==undefined&&!['cron','at','heartbeat','webhook'].includes(job.jobType))||e.proactive!==true||e.messageIds.length!==0||(e.attachments?.length??0)>0)throw new Error('Invalid job source envelope');
  }
  return {instance:e.instance,principal:e.principal,bot:e.bot,chatId:e.chatId,...(e.threadId===undefined?{}:{threadId:e.threadId}),messageIds:[...e.messageIds],originalAt:e.originalAt,content:e.content,proactive:e.proactive===true,attachments:e.attachments??[],...(e.job?{job:{dispatchId:e.job.dispatchId,jobId:e.job.jobId,...(e.job.jobType?{jobType:e.job.jobType}:{}),createdAt:e.job.createdAt}}:{})};
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceKey=(e:SourceEnvelope)=>e.job?hash([e.instance,e.principal,e.bot,'job',e.job.dispatchId]):hash([e.instance,e.principal,e.bot,e.chatId,e.threadId??null,e.messageIds]);
export const fingerprint=(e:SourceEnvelope)=>hash(normalize(e));
export type IngressRuntime={harness:Harness;root:Conversation;agent:AgentChange;store:HostStorage;onEpochChange?:(tx:Tx,previousConversationIds:ConversationId[],nextEpoch:number)=>Promise<void>};
export async function accept(p:IngressRuntime,e:SourceEnvelope,idleMs?:number) {
  const envelope=normalize(e), key=sourceKey(envelope), fp=fingerprint(envelope);
  const binding=await p.root.commit(async tx=>{
    const state=await tx.doc(Bindings,p.root.id), existing=state.sources[key];
    if(existing){if(existing.fingerprint!==fp)throw new Error('Source payload conflict');return {...existing};}
    if(!envelope.proactive){
      if(idleMs!==undefined&&state.lastHumanAt>0&&envelope.originalAt-state.lastHumanAt>=idleMs) {state.epoch++;await p.onEpochChange?.(tx,Object.values(state.epochs),state.epoch);}
      state.lastHumanAt=Math.max(state.lastHumanAt,envelope.originalAt);
    }
    let conversationId=state.epochs[String(state.epoch)];
    if(conversationId===undefined){const conversation=await tx.createConversation({ownership:{kind:'ownerless'}});await configure(tx,conversation.id,p.agent);conversationId=conversation.id;state.epochs[String(state.epoch)]=conversationId;}
    const value:Binding={conversationId,epoch:state.epoch,fingerprint:fp,chatId:envelope.chatId,threadId:envelope.threadId??null,originalAt:envelope.originalAt,principal:envelope.principal,proactive:envelope.proactive===true,envelope};state.sources[key]=value;return value;
  },context);
  p.store.inbox.persist(key,JSON.stringify(envelope),envelope.originalAt);
  return {key,binding};
}
export async function admit(p:IngressRuntime,e:SourceEnvelope) {
  const key=sourceKey(e), state=await p.harness.snapshot(Bindings,p.root.id,context), binding=state?.sources[key];
  if(!binding || binding.fingerprint!==fingerprint(e)) throw new Error('Source binding missing or changed');
  if(binding.cancelled){p.store.inbox.remove(key);return undefined;}
  const conversation=await p.harness.conversation(binding.conversationId,context);
  if(!conversation)throw new Error('Bound conversation missing');
  const submission=await conversation.submit({type:'input',whenBusy:'followUp',requestId:key,content:e.content,entry:{kind:'bridge.source',data:{sourceId:key,originalAt:binding.originalAt,chatId:binding.chatId,threadId:binding.threadId,attachments:e.attachments??[],...(e.job?{job:{...e.job}}:{})}}},context);
  await p.root.commit(async tx=>{const value=(await tx.doc(Bindings,p.root.id)).sources[key]!;if(value.submissionId!==undefined&&value.submissionId!==submission.id)throw new Error('Submission receipt mismatch');value.submissionId=submission.id;},context);
  p.store.inbox.remove(key);
  return submission;
}
