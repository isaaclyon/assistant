import { createHash } from 'node:crypto';
import { defineDoc, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { HostControlRejectedError, type DurableHost } from './host.js';
import { Bindings, context, type Target } from './ingress.js';
import { UiRejectedError, type NativeUiController, type UiOrigin } from './telegram-bridge.js';
import { groupNewPresentation, type Presentation } from './telegram-ui.js';
import type { NativeConfig } from './config.js';
import { chatIdOf } from './surface.js';

type Item={actorId:number;userMessageId:number;messageId:number|null;epoch:number;createdAt?:number;status:'pending'|'approved'|'cancelled'|'consumed'};
/** Per-request confirmation state. Bound to one actor, one bot message and the conversation epoch. */
export const GroupNewDoc=defineDoc({kind:'bridge.group-new',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({items:{} as Record<string,Item>})});
const keyFor=(commandId:string)=>createHash('sha256').update(commandId).digest('hex').slice(0,32);
/** A confirmation is valid for ten minutes. Items without a trusted timestamp (older state) never confirm. */
export const GROUP_NEW_CONFIRMATION_MS=10*60_000;
const BUSY='Cannot start a new shared session while busy. Wait for pending work to finish or use /stop.';

export interface GroupNewOptions {
 config:NativeConfig;
 host:()=>DurableHost;
 present(target:Target,presentation:Presentation):Promise<{messageId:number}>;
 /** Wall clock in milliseconds; injectable for tests. */
 now?:()=>number;
}
/** Household `/new` needs the requester's explicit confirmation. Busy state is checked when asked and again when confirmed. */
export function createGroupNew(options:GroupNewOptions):NonNullable<NativeUiController['groupNew']> {
 const {config}=options,now=options.now??Date.now,chatId=chatIdOf(config),target:Target={chatId};
 const controlId=(key:string)=>`telegram-control:${config.transport.botId}:group-new-${key}`;
 const busy=async(host:DurableHost)=>{
  const {harness,root,store}=host.runtime;
  if(store.inbox.pending().length)return true;
  const state=await harness.snapshot(Bindings,root.id,context),cid=state?.epochs[String(state.epoch)];
  if(cid===undefined)return false;
  const live=await harness.snapshot(LiveDoc,cid,context),inbox=await harness.snapshot(InboxDoc,cid,context);
  return !!live?.run||!!live?.compactions?.length||(inbox?.items.length??0)>0;
 };
 const fresh=(item:Item)=>{const age=now()-(item.createdAt??Number.NaN);return Number.isFinite(age)&&age>=-60_000&&age<=GROUP_NEW_CONFIRMATION_MS;};
 const authentic=(request:UiOrigin)=>{
  if(request.principal!==config.principal||request.target.chatId!==chatId||request.target.threadId!==undefined||!config.group?.actors.some(actor=>actor.id===request.actorId))throw new UiRejectedError('This action is unavailable.');
 };
 return {
  async request(request) {
   authentic(request);
   const host=options.host(),key=keyFor(request.commandId);
   const item=await host.administration(async()=>{
    const existing=(await host.runtime.harness.snapshot(GroupNewDoc,host.runtime.root.id,context))?.items[key];
    if(existing)return existing;
    if(await busy(host))throw new UiRejectedError(BUSY);
    return host.runtime.root.commit(async tx=>{
     const epoch=(await tx.doc(Bindings,host.runtime.root.id)).epoch,items=(await tx.doc(GroupNewDoc,host.runtime.root.id)).items;
     return items[key]??={actorId:request.actorId,userMessageId:request.userMessageId,messageId:null,epoch,createdAt:now(),status:'pending'};
    },context);
   });
   // A replay after a crash re-sends only when no confirmation message was recorded.
   if(item.messageId!==null||item.status!=='pending')return;
   if(!fresh(item)){await host.runtime.root.commit(async tx=>{const value=(await tx.doc(GroupNewDoc,host.runtime.root.id)).items[key];if(value?.status==='pending'&&value.messageId===null)value.status='cancelled';},context);return;}
   const sent=await options.present(target,groupNewPresentation(key));
   await host.runtime.root.commit(async tx=>{const value=(await tx.doc(GroupNewDoc,host.runtime.root.id)).items[key];if(value&&value.messageId===null)value.messageId=sent.messageId;},context);
  },
  async decide(request) {
   authentic(request);
   const host=options.host();
   const decision=await host.runtime.root.commit(async tx=>{
    const items=(await tx.doc(GroupNewDoc,host.runtime.root.id)).items,item=items[request.key];
    if(!item||item.actorId!==request.actorId||item.messageId!==request.messageId)return 'expired' as const;
    if(request.choice==='deny'){if(item.status!=='pending')return 'expired' as const;if(!fresh(item)){item.status='cancelled';return 'expired' as const;}item.status='cancelled';return 'denied' as const;}
    const epoch=(await tx.doc(Bindings,host.runtime.root.id)).epoch;
    if(item.status==='approved'){
     // Replay of an unfinished approval reuses the same control request. A changed epoch means the session already moved on.
     if(epoch!==item.epoch){item.status='consumed';return 'expired' as const;}
     return 'approved' as const;
    }
    if(item.status!=='pending')return 'expired' as const;
    if(!fresh(item)||epoch!==item.epoch){item.status='cancelled';return 'expired' as const;}
    item.status='approved';return 'approved' as const;
   },context);
   if(decision==='expired')throw new UiRejectedError('This confirmation expired or was already used.');
   if(decision==='denied')return {view:{kind:'text',text:'New shared session cancelled.'},toast:'Cancelled'};
   const finish=(status:Item['status'])=>host.runtime.root.commit(async tx=>{(await tx.doc(GroupNewDoc,host.runtime.root.id)).items[request.key]!.status=status;},context);
   try{
    await host.control({type:'new',requestId:controlId(request.key),principal:config.principal,target});
   }catch(error){
    if(error instanceof HostControlRejectedError){await finish('cancelled');throw new UiRejectedError(error.message);}
    throw error;
   }
   await finish('consumed');
   return {view:{kind:'text',text:'Started a new shared session.'},toast:'Started'};
  },
 };
}
