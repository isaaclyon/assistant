import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { configure, defineDoc, type UserInput, type AgentChange, type Conversation, type ConversationId, type Harness, type SubmissionId, type Tx } from '@earendil-works/pi-durable';
import type { HostStorage } from './storage.js';
export { context };
export type Target = {chatId:number; threadId?:number};
export type JobSource = {dispatchId:string;jobId:string;jobType?:'cron'|'at'|'heartbeat'|'webhook';createdAt:string};
export type ChildSource = {batchId:string;completionId:string};
export type SourceActor = {id:number;label:string};
export type SourceEnvelope = Target & {actor?:SourceActor;instance:string;principal:string;bot:string;messageIds:number[];originalAt:number;content:string;proactive?:boolean;attachments?:JsonValue[];job?:JobSource;child?:ChildSource};
export type Binding = {conversationId:ConversationId;epoch:number;fingerprint:string;chatId:number;threadId:number|null;originalAt:number;principal:string;proactive:boolean;envelope:SourceEnvelope;submissionId?:SubmissionId;cancelled?:boolean;deliveryComplete?:boolean;wakeComplete?:boolean};
export const Bindings = defineDoc({kind:'bridge.sources',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({epoch:0,lastHumanAt:0,epochs:{} as Record<string,ConversationId>,sources:{} as Record<string,Binding>,rotations:{} as Record<string,number>})});
// Canonical field order also makes inbox bytes stable across equivalent transport objects.
export function normalize(e:SourceEnvelope):SourceEnvelope {
  if (!e.instance || !e.principal || !e.bot || !Number.isSafeInteger(e.chatId) || !Number.isSafeInteger(e.originalAt) || e.originalAt<0 || !Array.isArray(e.messageIds) || (!e.messageIds.length&&!e.job&&!e.child) || e.messageIds.some(id=>!Number.isSafeInteger(id)) || typeof e.content!=='string' || (e.actor!==undefined&&(!e.actor||typeof e.actor!=='object'||Object.keys(e.actor).some(k=>!['id','label'].includes(k))||!Number.isSafeInteger(e.actor.id)||typeof e.actor.label!=='string'||!/^[A-Za-z]{1,32}$/.test(e.actor.label)||e.proactive===true)) || (e.threadId!==undefined&&!Number.isSafeInteger(e.threadId))) throw new Error('Invalid source envelope');
  if(e.job!==undefined){
    const job=e.job;
    if(!job||typeof job!=='object'||Array.isArray(job)||Object.keys(job).some(k=>!['dispatchId','jobId','jobType','createdAt'].includes(k))||typeof job.jobId!=='string'||!/^[a-z0-9-]{1,64}$/.test(job.jobId)||typeof job.dispatchId!=='string'||!new RegExp(`^${job.jobId}-[a-f0-9]{16}(?:[a-f0-9]{48})?$`).test(job.dispatchId)||typeof job.createdAt!=='string'||!Number.isFinite(Date.parse(job.createdAt))||Date.parse(job.createdAt)!==e.originalAt||(job.jobType!==undefined&&!['cron','at','heartbeat','webhook'].includes(job.jobType))||e.proactive!==true||e.messageIds.length!==0||(e.attachments?.length??0)>0)throw new Error('Invalid job source envelope');
  }
  if(e.child!==undefined){
    const child=e.child;
    if(!child||typeof child!=='object'||Array.isArray(child)||Object.keys(child).some(k=>!['batchId','completionId'].includes(k))||!['batchId','completionId'].every(k=>typeof child[k as keyof ChildSource]==='string'&&/^[a-f0-9]{64}$/.test(child[k as keyof ChildSource]))||e.job!==undefined||e.proactive!==true||e.messageIds.length!==0||(e.attachments?.length??0)>0)throw new Error('Invalid child source envelope');
  }
  return {instance:e.instance,principal:e.principal,bot:e.bot,chatId:e.chatId,...(e.threadId===undefined?{}:{threadId:e.threadId}),messageIds:[...e.messageIds],originalAt:e.originalAt,content:e.content,...(e.actor?{actor:{id:e.actor.id,label:e.actor.label}}:{}),proactive:e.proactive===true,attachments:e.attachments??[],...(e.job?{job:{dispatchId:e.job.dispatchId,jobId:e.job.jobId,...(e.job.jobType?{jobType:e.job.jobType}:{}),createdAt:e.job.createdAt}}:{}),...(e.child?{child:{batchId:e.child.batchId,completionId:e.child.completionId}}:{})};
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceKey=(e:SourceEnvelope)=>e.child?hash([e.instance,e.principal,e.bot,'child',e.child.completionId]):e.job?hash([e.instance,e.principal,e.bot,'job',e.job.dispatchId]):hash([e.instance,e.principal,e.bot,e.chatId,e.threadId??null,e.messageIds]);
export const fingerprint=(e:SourceEnvelope)=>hash(normalize(e));
export type IngressRuntime={harness:Harness;root:Conversation;agent:AgentChange;store:HostStorage;routeHuman?:(envelope:SourceEnvelope)=>Promise<{expectedEpoch:number;rotate:boolean}>;onEpochChange?:(tx:Tx,previousConversationIds:ConversationId[],nextEpoch:number)=>Promise<void>};
export async function accept(p:IngressRuntime,e:SourceEnvelope,idleMs?:number) {
  const envelope=normalize(e), key=sourceKey(envelope), fp=fingerprint(envelope);
  if(envelope.child)throw new Error('Child reports require an original conversation binding');
  const route=envelope.proactive?undefined:await p.routeHuman?.(envelope);
  const binding=await p.root.commit(async tx=>{
    const state=await tx.doc(Bindings,p.root.id), existing=state.sources[key];
    if(existing){if(existing.fingerprint!==fp)throw new Error('Source payload conflict');return {...existing};}
    if(!envelope.proactive){
      if(route&&route.expectedEpoch!==state.epoch)throw new Error('Conversation changed during routing acceptance');
      if(route?.rotate||(!p.routeHuman&&idleMs!==undefined&&state.lastHumanAt>0&&envelope.originalAt-state.lastHumanAt>=idleMs)) {state.epoch++;await p.onEpochChange?.(tx,Object.values(state.epochs),state.epoch);}
      state.lastHumanAt=Math.max(state.lastHumanAt,envelope.originalAt);
    }
    let conversationId=state.epochs[String(state.epoch)];
    if(conversationId===undefined){const conversation=await tx.createConversation({ownership:{kind:'ownerless'}});await configure(tx,conversation.id,p.agent);conversationId=conversation.id;state.epochs[String(state.epoch)]=conversationId;}
    const value:Binding={conversationId,epoch:state.epoch,fingerprint:fp,chatId:envelope.chatId,threadId:envelope.threadId??null,originalAt:envelope.originalAt,principal:envelope.principal,proactive:envelope.proactive===true,envelope};state.sources[key]=value;return value;
  },context);
  p.store.inbox.persist(key,JSON.stringify(envelope),envelope.originalAt);
  return {key,binding};
}
/** Optional admission-only adapter. It turns the stored envelope into model input (for example text plus images). */
export type InputAdapter=(e:SourceEnvelope,text:string)=>Promise<UserInput>;
export async function admit(p:IngressRuntime,e:SourceEnvelope,adapt?:InputAdapter) {
  const key=sourceKey(e), state=await p.harness.snapshot(Bindings,p.root.id,context), binding=state?.sources[key];
  if(!binding || binding.fingerprint!==fingerprint(e)) throw new Error('Source binding missing or changed');
  if(binding.cancelled){p.store.inbox.remove(key);return undefined;}
  const conversation=await p.harness.conversation(binding.conversationId,context);
  if(!conversation)throw new Error('Bound conversation missing');
  const submission=await conversation.submit({type:'input',whenBusy:'followUp',requestId:key,content:await (async()=>{const text=e.actor?`[telegram|actor:${e.actor.label}] ${e.content}`:e.content;return adapt&&(e.attachments?.length??0)>0?adapt(e,text):text;})(),entry:{kind:'bridge.source',data:{sourceId:key,originalAt:binding.originalAt,chatId:binding.chatId,threadId:binding.threadId,attachments:e.attachments??[],...(e.job?{job:{...e.job}}:{}),...(e.child?{child:{...e.child}}:{})}}},context);
  await p.root.commit(async tx=>{const value=(await tx.doc(Bindings,p.root.id)).sources[key]!;if(value.submissionId!==undefined&&value.submissionId!==submission.id)throw new Error('Submission receipt mismatch');value.submissionId=submission.id;},context);
  p.store.inbox.remove(key);
  return submission;
}

/** Trusted child completion ingress. Its recorded epoch can be older than the current
 * epoch; it never selects a new conversation or advances the human idle clock. */
export async function acceptChildReport(p:IngressRuntime,e:SourceEnvelope,origin:{conversationId:ConversationId;epoch:number}) {
  const envelope=normalize(e),key=sourceKey(envelope),fp=fingerprint(envelope);
  if(!envelope.child)throw new Error('Child report source required');
  const binding=await p.root.commit(async tx=>{
    const state=await tx.doc(Bindings,p.root.id);
    if(state.epochs[String(origin.epoch)]!==origin.conversationId)throw new Error('Original child conversation is unavailable');
    const original=Object.values(state.sources).filter(value=>value.conversationId===origin.conversationId&&!value.cancelled);
    if(!original.length||original.some(value=>value.principal!==envelope.principal||value.chatId!==envelope.chatId||value.threadId!==(envelope.threadId??null)||value.envelope.instance!==envelope.instance||value.envelope.bot!==envelope.bot))throw new Error('Child report authority changed');
    const existing=state.sources[key];
    if(existing){if(existing.fingerprint!==fp||existing.conversationId!==origin.conversationId||existing.epoch!==origin.epoch)throw new Error('Child report payload conflict');return {...existing};}
    const value:Binding={conversationId:origin.conversationId,epoch:origin.epoch,fingerprint:fp,chatId:envelope.chatId,threadId:envelope.threadId??null,originalAt:envelope.originalAt,principal:envelope.principal,proactive:true,envelope};
    state.sources[key]=value;return value;
  },context);
  p.store.inbox.persist(key,JSON.stringify(envelope),envelope.originalAt);
  return {key,binding};
}
