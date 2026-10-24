import type { NativeConfig } from './config.js';
import { HostControlRejectedError, type HostControl, type HostTransport } from './host.js';
import type { SourceActor, SourceEnvelope, Target } from './ingress.js';
import type { MediaIngest } from './media-ingest.js';
import type { createNativeTelegramTransport, TelegramUpdate } from './transport.js';
import { assertPresentation, clean, formatDiagnostics, modelMenu, parseCallbackData, parseCommandText, skillsList, statusMenu, thinkingMenu, unavailableText,
  type Buttons, type CallbackAction, type ControlCommand, type DiagnosticSection, type MenuState, type ModelChoice, type Presentation, type UiCommandName } from './telegram-ui.js';
import { createPreviewStream } from './telegram-stream.js';
import type { ToolActivityPort } from './tool-activity.js';
import { TELEGRAM_NATIVE_MEDIA_LIMITS } from '@llblab/pi-telegram/durable';
import { profilePolicy } from './profiles.js';
import { actorOf, chatIdOf } from './surface.js';

/** The ingest surface the bridge uses. The parent constructs it with the instance actor authorization. */
export type NativeMediaIngest=Pick<MediaIngest,'receive'|'recover'|'collect'|'requeue'|'done'|'nextDueAt'>;
export type RawTransport = Pick<ReturnType<typeof createNativeTelegramTransport>, 'start'|'stop'|'deliver'|'answerCallback'> &
  Partial<Pick<ReturnType<typeof createNativeTelegramTransport>, 'present'|'edit'|'preview'|'media'|'typing'>>;
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);

/** An expected, user-visible refusal (stale, expired, unauthorized). Acknowledged, never retried. */
export class UiRejectedError extends Error {}
/** Identity of a command or callback, taken only from authenticated Telegram metadata. */
export type UiOrigin={commandId:string;principal:string;actorId:number;target:Target;/** Message carrying the pressed button. */messageId?:number};
export type UiView=
 |{kind:'menu';state:MenuState}
 |{kind:'models';choices:readonly ModelChoice[];current?:string;page?:number}
 |{kind:'thinking';levels:readonly string[];current?:string}
 |{kind:'skills';skills:readonly {name:string;description?:string}[]}
 |{kind:'diagnostics';sections:readonly DiagnosticSection[]}
 |{kind:'text';text:string;buttons?:Buttons};
export type UiResult={view?:UiView;toast?:string;
 /** Runs only after the Telegram update offset is durably advanced (e.g. process restart), so a replayed update cannot restart twice. */
 afterAcknowledgement?:()=>void|Promise<void>};
export type UiCommandRequest=UiOrigin&({name:UiCommandName;arg?:string}|{name:'selectModel';arg:string}|{name:'selectThinking';arg:string}|{name:'model';arg?:string}|{name:'fast';arg?:string});
export type UiConfirmationRequest=UiOrigin&{messageId:number;key:string;choice:'approve'|'deny'};
/** Parent-composed host side. Implementations must treat commandId as an idempotency key. */
export interface NativeUiController {
  command(request:UiCommandRequest):Promise<UiResult>;
  /** Resolve `key` to the persisted memory approval and decide with principal/target/messageId taken from this request, never from the key. */
  confirmation(request:UiConfirmationRequest):Promise<UiResult>;
  calendar?(request:UiOrigin&{messageId:number;key:string}):Promise<UiResult>;
  places?(request:UiOrigin&{messageId:number;key:string}):Promise<UiResult>;
  /** Household group /new: durable per-actor confirmation. Only present on a group surface. */
  groupNew?:{
    request(request:UiOrigin&{userMessageId:number}):Promise<void>;
    decide(request:UiOrigin&{messageId:number;key:string;choice:'approve'|'deny'}):Promise<UiResult>;
  };
  /** Exact private reply capture; true consumes the input before model admission. */
  placesInput?(request:UiOrigin&{messageId:number;replyToMessageId:number;text:string;trustedPromptText?:string}):Promise<boolean>;
}
export type TrustedCallback={id:string;commandId:string;actorId:number;principal:string;target:Target;messageId:number;data:string;action:CallbackAction|undefined};
export type NormalizedUpdate =
 |{type:'input';envelope:SourceEnvelope}
 |{type:'control';control:HostControl}
 |{type:'groupNew';origin:UiOrigin&{userMessageId:number}}
 |{type:'deploy';envelope:SourceEnvelope}
 |{type:'media';message:Record<string,unknown>;actor?:SourceActor}
 |{type:'ui';origin:UiOrigin;name:UiCommandName;arg?:string}
 |{type:'callback';callback:TrustedCallback}
 |{type:'ignored'}
 |{type:'rejected';reason:string};
export const controlFor=(config:NativeConfig,updateId:number,type:ControlCommand):HostControl=>({type,requestId:`telegram-control:${config.transport.botId}:${updateId}`,principal:config.principal,target:{chatId:chatIdOf(config)}});
/** Private text and callback boundary. Full grouped/media and household surfaces are C6 gates. */
export function normalizeTelegramUpdate(config:NativeConfig,update:TelegramUpdate,commands?:ReadonlySet<string>):NormalizedUpdate {
 if(!integer(update.update_id)||update.update_id<0) throw new Error('Invalid Telegram update identity');
 const callback=object(update.callback_query);
 const message=object(callback?.message??update.message);
 if(!message) return {type:'ignored'};
 const from=object(callback?.from??message.from),chat=object(message.chat);
 const actor=from?.is_bot===true?undefined:actorOf(config,from?.id);
 const chatId=chatIdOf(config);
 if(!actor||chat?.id!==chatId||chat.type!==(config.group?undefined:'private')&&!(config.group&&(chat.type==='group'||chat.type==='supergroup')))return {type:'ignored'};
 const target:Target={chatId};
 // Forum topics are outside the household surface. Plain supergroup reply threads are not topics.
 const threaded=config.group?message.is_topic_message===true||(chat.is_forum===true&&message.message_thread_id!==undefined):message.message_thread_id!==undefined;
 if(callback){
  if(typeof callback.id!=='string'||callback.id.length===0||callback.id.length>128)throw new Error('Invalid callback identity');
  if(!integer(message.message_id)||message.message_id<=0)throw new Error('Invalid callback message');
  const data=typeof callback.data==='string'?callback.data:'';
  const action=threaded?undefined:parseCallbackData(data);
  return {type:'callback',callback:{id:callback.id,commandId:`telegram-callback:${config.transport.botId}:${update.update_id}`,actorId:actor.id,principal:config.principal,target,messageId:message.message_id,data,action}};
 }
 if(!integer(message.message_id)||message.message_id<=0||!integer(message.date)||message.date<0)throw new Error('Invalid Telegram source');
 // Media is considered only after actor, chat and topic checks, and only for profiles that enable it.
 if(!threaded&&typeof message.text!=='string'&&profilePolicy(config.capabilityProfile)?.media===true)
  return {type:'media',message,...(config.group&&actor.label?{actor:{id:actor.id,label:actor.label}}:{})};
 if(typeof message.text!=='string'||message.media_group_id!==undefined||message.photo!==undefined||message.document!==undefined||message.voice!==undefined)return {type:'rejected',reason:config.group?'The household group accepts ungrouped text messages only.':'This native foundation profile requires an ungrouped text message.'};
 if(threaded)return {type:'rejected',reason:config.group?'Topic input is unavailable on the household group surface.':'Thread input is unavailable on the private foundation surface.'};
 const parsed=parseCommandText(message.text,commands);
 const origin:UiOrigin={commandId:`telegram-command:${config.transport.botId}:${update.update_id}`,principal:config.principal,actorId:actor.id,target};
 const source:SourceEnvelope={instance:config.instanceId,principal:config.principal,bot:String(config.transport.botId),chatId,messageIds:[message.message_id],originalAt:message.date*1000,content:message.text,...(config.group&&actor.label?{actor:{id:actor.id,label:actor.label}}:{})};
 if(parsed.type==='control'){
  if(config.group&&parsed.name==='new')return {type:'groupNew',origin:{...origin,userMessageId:message.message_id}};
  return {type:'control',control:controlFor(config,update.update_id,parsed.name)};
 }
 if(parsed.type==='ui'&&parsed.name==='deploy')return {type:'deploy',envelope:{...source,content:''}};
 if(parsed.type==='ui')return {type:'ui',name:parsed.name,...(parsed.arg?{arg:parsed.arg}:{}),origin};
 if(parsed.type==='unavailable')return {type:'rejected',reason:unavailableText(parsed)};
 return {type:'input',envelope:source};
}
export function assertNativeEnvelope(config:NativeConfig,envelope:SourceEnvelope):void {
 const policy=profilePolicy(config.capabilityProfile);
 const rejected=()=>new Error('Source is outside this instance authority');
 if(!policy||envelope.instance!==config.instanceId||envelope.principal!==config.principal||envelope.bot!==String(config.transport.botId)||envelope.chatId!==chatIdOf(config)||envelope.threadId!==undefined)throw rejected();
 const attachments=envelope.attachments??[];
 if(attachments.length>0){
  // Structural only. The application verifies each artifact with assertMediaAttachments.
  if(!policy.media||envelope.child||envelope.job||envelope.proactive===true||attachments.length>TELEGRAM_NATIVE_MEDIA_LIMITS.maxFilesPerMessage*10||attachments.some(item=>object(item)===undefined))throw rejected();
 }
 if(envelope.child){if(!policy.children||envelope.proactive!==true||envelope.messageIds.length!==0||envelope.actor)throw rejected();return;}
 if(envelope.job){if(config.jobsRole==='disabled'||!policy.jobsRoles.includes(config.jobsRole)||envelope.proactive!==true||envelope.messageIds.length!==0||envelope.actor)throw rejected();return;}
 if(envelope.proactive===true)throw rejected();
 // Human input: a group source must name one of its two configured actors.
 if(config.group){const actor=envelope.actor;if(!actor||!config.group.actors.some(item=>item.id===actor.id&&item.label===actor.label))throw rejected();}
 else if(envelope.actor)throw rejected();
}
export function assertNativeControl(config:NativeConfig,control:HostControl):void {
 if(control.principal!==config.principal||control.target.chatId!==chatIdOf(config)||control.target.threadId!==undefined||!control.requestId.startsWith(`telegram-control:${config.transport.botId}:`))throw new Error('Control is outside this instance authority');
}
export type NativeBridgeOptions={
 /** Slash/callback UI behavior. Without it only durable controls work and other commands are refused. */
 ui?:NativeUiController;
 /** Restrict enabled slash commands (profile visibility). Defaults to all. */
 commands?:readonly string[];
 previewIntervalMs?:number;
 /** Release-owned /deploy prompt. Only builder-class profiles provide it. */
 deployPrompt?:()=>Promise<string>;
 /** Media ingest for profiles with media enabled. Without it, media updates are refused visibly. */
 media?:NativeMediaIngest;
};
const ACCEPT_RETRY_LIMIT=5,TIMER_FAILURE_LIMIT=5;
const view=(item:UiView):Presentation=>{
 switch(item.kind){
  case 'menu':return statusMenu(item.state);
  case 'models':return modelMenu(item.choices,item.current,item.page??0);
  case 'thinking':return thinkingMenu(item.levels,item.current);
  case 'skills':return skillsList(item.skills);
  case 'diagnostics':return formatDiagnostics(item.sections);
  case 'text':return assertPresentation({text:item.text,...(item.buttons?{buttons:item.buttons}:{})});
 }
};
export function bridgeTelegram(config:NativeConfig,raw:RawTransport,onTransportFailure:(error:unknown)=>void,options:NativeBridgeOptions={}):HostTransport&{
 /** Narrow rich-output port for memory confirmations and other trusted callers. Target-bound to this instance. */
 presenter:{present(target:Target,presentation:Presentation):Promise<{messageId:number}>};
 /** Visible assistant text only; the durable final remains authoritative. */
 stream:{update(target:Target,turn:string,text:string):void;finish(target:Target,turn:string):Promise<void>};
 /** Transient tool-activity message port for the private instance target. Absent when the raw transport cannot send. */
 activity:ToolActivityPort;
 typing(target:Target,signal:AbortSignal):Promise<unknown>;
} {
 const allowed=(target:Target)=>target.chatId===chatIdOf(config)&&target.threadId===undefined;
 const only=(target:Target)=>{if(!allowed(target))throw Object.assign(new Error('Delivery target outside instance authority'),{definitelyNotSent:true});};
 const commands=options.commands?new Set(options.commands):undefined;
 const home:Target={chatId:chatIdOf(config)};
 // Rejections are not accepted work. Their notices are best effort, so an
 // uncertain notice cannot cause a rejected update to block or execute later.
 const reject=async(reason:string)=>{try{await raw.deliver(home,clean(reason,500));}catch(error){onTransportFailure(error);}};
 const present=async(presentation:Presentation)=>{if(!raw.present)throw new Error('Presentation port unavailable');return raw.present(home,presentation);};
 const best=async(work:()=>Promise<unknown>)=>{try{await work();}catch(error){onTransportFailure(error);}};
 const answer=(id:string,text?:string)=>best(()=>raw.answerCallback(id,clean(text??'',200)));
 const render=async(origin:{messageId?:number},item:Presentation)=>{
  if(origin.messageId!==undefined&&raw.edit){
   try{await raw.edit(home,origin.messageId,item);return;}catch{/* Not modified or stale: send a fresh message instead. */}
  }
  await best(()=>present(item));
 };
 const afterAck=new Map<number,(()=>void|Promise<void>)[]>();
 const defer=(updateId:number,fn:(()=>void|Promise<void>)|undefined)=>{if(fn)afterAck.set(updateId,[...(afterAck.get(updateId)??[]),fn]);};
 const showMenu=async(origin:UiOrigin)=>{
  const ui=options.ui;if(!ui)return;
  try{const menu=await ui.command({...origin,name:'menu'});if(menu.view)await render(origin,view(menu.view));}catch(error){onTransportFailure(error);}
 };
 async function runUi(updateId:number,request:UiCommandRequest,callbackId?:string):Promise<UiResult|undefined>{
  const ui=options.ui;
  if(!ui){if(callbackId)await answer(callbackId,'Unavailable');else await reject(unavailableText({type:'unavailable',command:request.name,reason:'disabled'}));return undefined;}
  let result:UiResult;
  try{result=await ui.command(request);}
  catch(error){
   const text=error instanceof UiRejectedError?error.message:'Command failed.';
   if(callbackId)await answer(callbackId,text);else await reject(text);
   return undefined;
  }
  if(result.view){
   // Diagnostics reply only to the originating private target; the controller cannot choose another.
   try{await render(request,view(result.view));}catch(error){await reject('Command output was not valid.');onTransportFailure(error);}
  }
  if(callbackId)await answer(callbackId,result.toast);
  defer(updateId,result.afterAcknowledgement);
  return result;
 }
 async function runControl(control:HostControl,origin:{messageId?:number;actorId?:number},callbackId?:string){
  try{await onControlRef(control);}
  catch(error){if(error instanceof HostControlRejectedError){if(callbackId)await answer(callbackId,error.message);else await reject(error.message);return;}throw error;}
  if(callbackId)await answer(callbackId);
  // A successful /new returns to the status menu.
  if(control.type==='new')await showMenu({commandId:`menu:${control.requestId}`,principal:control.principal,actorId:origin.actorId??config.transport.allowedUserId,target:home,...(origin.messageId!==undefined?{messageId:origin.messageId}:{})});
 }
 let onControlRef:(control:HostControl)=>Promise<void>=async()=>{throw new Error('Bridge not started');};
 const streamer=createPreviewStream({authorize:target=>!config.group&&allowed(target),...(options.previewIntervalMs!==undefined?{intervalMs:options.previewIntervalMs}:{}),
  send:(target,text)=>raw.preview?raw.preview(target,text):Promise.resolve(),onError:()=>{/* previews are best effort */}});
 const callbackFor=async(updateId:number,item:TrustedCallback)=>{
  const action=item.action;
  if(!action){await answer(item.id,'This action is unavailable.');return;}
  const origin:UiOrigin={commandId:item.commandId,principal:item.principal,actorId:item.actorId,target:item.target,messageId:item.messageId};
  switch(action.type){
   case 'groupNew':{
    const ui=options.ui?.groupNew;if(!ui){await answer(item.id,'Unavailable');return;}
    let result:UiResult;
    try{result=await ui.decide({...origin,messageId:item.messageId,key:action.key,choice:action.choice});}
    catch(error){if(error instanceof UiRejectedError){await answer(item.id,error.message);return;}throw error;}
    if(result.view)await render(origin,view(result.view));
    if(result.view&&action.choice==='approve')await showMenu({...origin,commandId:`menu:${item.commandId}`,messageId:undefined} as UiOrigin);
    await answer(item.id,result.toast);defer(updateId,result.afterAcknowledgement);return;
   }
   case 'control':
    // A household /new is a shared-session decision that needs the requester's confirmation.
    if(config.group&&action.name==='new'){
     const ui=options.ui?.groupNew;if(!ui){await answer(item.id,'Unavailable');return;}
     try{await ui.request({...origin,userMessageId:item.messageId});await answer(item.id);}
     catch(error){if(error instanceof UiRejectedError){await answer(item.id,error.message);return;}throw error;}
     return;
    }
    return runControl(controlFor(config,updateId,action.name),origin,item.id);
   case 'menu':await runUi(updateId,{...origin,name:action.name==='menu'?'menu':action.name},item.id);return;
   case 'modelPage':await runUi(updateId,{...origin,name:'model',arg:String(action.page)},item.id);return;
   case 'model':case 'thinking':{
    const result=await runUi(updateId,{...origin,name:action.type==='model'?'selectModel':'selectThinking',arg:action.type==='model'?action.id:action.level} as UiCommandRequest,item.id);
    if(result)await showMenu(origin);   // Selection returns to the status menu.
    return;
   }
   case 'calendar':case 'places':{
    const handler=action.type==='calendar'?options.ui?.calendar:options.ui?.places;if(!handler){await answer(item.id,'Unavailable');return;}
    try{const result=await handler({...origin,messageId:item.messageId,key:action.key});await answer(item.id,result.toast);}
    catch(error){if(error instanceof UiRejectedError){await answer(item.id,error.message);return;}throw error;}
    return;
   }
   case 'confirmation':{
    const ui=options.ui;if(!ui){await answer(item.id,'Unavailable');return;}
    let result:UiResult;
    // Storage failures propagate (unacknowledged, retried); expected refusals are acknowledged.
    try{result=await ui.confirmation({...origin,messageId:item.messageId,key:action.key,choice:action.choice});}
    catch(error){if(error instanceof UiRejectedError){await answer(item.id,error.message);return;}throw error;}
    if(result.view)await render(origin,view(result.view));
    await answer(item.id,result.toast);defer(updateId,result.afterAcknowledgement);return;
   }
  }
 };

 // Media: receive and collect are serialized so a timer can never race an update.
 const media=options.media;
 let chain:Promise<unknown>=Promise.resolve(),stopped=false,timer:ReturnType<typeof setTimeout>|undefined,timerFailures=0;
 const serial=<T>(work:()=>Promise<T>):Promise<T>=>{const next=chain.then(work,work);chain=next.catch(()=>{});return next;};
 const acceptFailures=new Map<string,number>();
 let envelopeSink:(envelope:SourceEnvelope)=>Promise<void>=async()=>{throw new Error('Bridge not started');};
 const arm=()=>{
  if(!media||stopped)return;
  if(timer)clearTimeout(timer);timer=undefined;
  const due=media.nextDueAt();if(due===undefined)return;
  timer=setTimeout(()=>{timer=undefined;void collectDue();},Math.min(2**31-1,Math.max(10,due-Date.now())));
  timer.unref?.();
 };
 /** Must run inside serial(). Accepts every due album, or re-queues it after an acceptance failure. */
 async function drain():Promise<void>{
  if(!media)return;
  const due=await media.collect();
  for(const error of due.failed)onTransportFailure(error);
  for(const item of due.rejected)await reject(item.reason);
  let failure:unknown,failedAny=false;
  for(const item of due.inputs){
   const key=item.messageIds.join(',');
   try{await envelopeSink(item.envelope);await media.done(item.messageIds);acceptFailures.delete(key);}
   catch(error){
    onTransportFailure(error);
    const count=(acceptFailures.get(key)??0)+1;acceptFailures.set(key,count);
    // The journal keeps the album. After the bound it stays journaled for the next restart.
    if(count<ACCEPT_RETRY_LIMIT){try{media.requeue(item.messageIds);}catch(requeueError){onTransportFailure(requeueError);}}
    else{acceptFailures.delete(key);onTransportFailure(new Error('Media album acceptance failed repeatedly; it stays journaled for restart.'));}
    failedAny=true;failure=error;
   }
  }
  if(failedAny)throw failure;
 }
 async function collectDue():Promise<void>{
  if(stopped)return;
  let failed=false;
  try{await serial(drain);}catch{failed=true;}
  if(failed){if(++timerFailures>=TIMER_FAILURE_LIMIT){onTransportFailure(new Error('Media album retries paused until the next update or restart.'));return;}}
  else timerFailures=0;
  arm();
 }
 async function acceptMedia(item:{message:Record<string,unknown>;actor?:SourceActor},updateId:number):Promise<void>{
  if(!media){await reject('Media is unavailable on this instance.');return;}
  await serial(async()=>{
   const result=await media.receive(item.message,{updateId,...(item.actor?{actor:item.actor}:{})});
   switch(result.type){
    case 'none':await reject('This message type is not supported.');return;
    case 'rejected':await reject(result.reason);return;
    case 'pending':return;
    case 'input':await envelopeSink(result.envelope);await media.done(result.messageIds);return;
   }
  });
  arm();
 }
 return {
  start:async(onEnvelope,onControl)=>{
   onControlRef=onControl;envelopeSink=onEnvelope;stopped=false;
   // Recovery fails closed: an unreadable or unauthorized journal stops startup before any update is read.
   if(media)await media.recover();
   await raw.start({accept:async(update)=>{
    try{
     const item=normalizeTelegramUpdate(config,update,commands);
     if(item.type==='input'){
      const message=object(update.message),reply=object(message?.reply_to_message);
      const handler=options.ui?.placesInput;
      if(handler&&integer(reply?.message_id)&&reply!.message_id>0){
       const author=object(reply?.from),chat=object(reply?.chat);
        const trustedPromptText=author?.id===config.transport.botId&&author?.is_bot===true&&chat?.type==='private'&&chat?.id===home.chatId&&typeof reply?.text==='string'?reply.text:undefined;
        const consumed=await handler({commandId:`telegram-reply:${config.transport.botId}:${update.update_id}`,principal:config.principal,actorId:config.transport.allowedUserId,target:home,messageId:item.envelope.messageIds[0]!,replyToMessageId:reply!.message_id,text:item.envelope.content,...(trustedPromptText===undefined?{}:{trustedPromptText})});
       if(consumed)return;
      }
      await onEnvelope(item.envelope);
     }
     else if(item.type==='control')await runControl(item.control,{actorId:object(object(update.message)?.from)?.id as number});
     else if(item.type==='groupNew'){
      const ui=options.ui?.groupNew;
      if(!ui)await reject('/new is unavailable on this instance.');
      else{try{await ui.request(item.origin);}catch(error){if(error instanceof UiRejectedError)await reject(error.message);else throw error;}}
     }
     else if(item.type==='media')await acceptMedia(item,update.update_id);
     else if(item.type==='deploy'){
      const prompt=await options.deployPrompt?.();
      if(!prompt)await reject('/deploy is unavailable on this instance.');
      else await onEnvelope({...item.envelope,content:prompt});
     }
     else if(item.type==='ui')await runUi(update.update_id,{...item.origin,name:item.name,...(item.arg?{arg:item.arg}:{})},undefined);
     else if(item.type==='rejected')await reject(item.reason);
     else if(item.type==='callback')await callbackFor(update.update_id,item.callback);
    }catch(error){afterAck.delete(update.update_id);throw error;}
   },acknowledged:async(updateId:number)=>{
    const work=afterAck.get(updateId);afterAck.delete(updateId);
    for(const fn of work??[])await fn();
   },failed:onTransportFailure});
   // Recovered albums become due after their quiet period.
   if(media)arm();
  },
  stop:async()=>{
   stopped=true;if(timer)clearTimeout(timer);timer=undefined;streamer.stop();
   await raw.stop();await chain.catch(()=>{});
  },
  sendFinal:async request=>{
   only(request.target);
   const messageId=await raw.deliver(request.target,request.text);
   if(!integer(messageId)||messageId<=0)throw new Error('Telegram delivery receipt missing');
   return {messageId};
  },
  presenter:{present:async(target,presentation)=>{
   only(target);if(!raw.present)throw Object.assign(new Error('Presentation port unavailable'),{definitelyNotSent:true});
   return {messageId:await raw.present(target,presentation)};
  }},
  typing:async(target,signal)=>{only(target);if(!signal.aborted)await raw.typing?.(target,signal);},
  stream:{update:(target,turn,text)=>streamer.update(target,turn,text),finish:(target,turn)=>streamer.finish(target,turn)},
  activity:{
   // Private chat only (like previews); every call passes the transport's pairing and field policy.
   send:async(target,text)=>{
    if(config.group||!allowed(target)||!raw.media)return undefined;
    const r=await raw.media.call('sendMessage',{chat_id:target.chatId,text,disable_notification:true});
    const id=r.payload?.result?.message_id;return integer(id)&&id>0?id:undefined;
   },
   edit:async(target,messageId,text)=>{
    if(config.group||!allowed(target)||!raw.media)return;
    await raw.media.call('editMessageText',{chat_id:target.chatId,message_id:messageId,text});
   },
   remove:async(target,messageId)=>{
    if(config.group||!allowed(target)||!raw.media)return;
    await raw.media.call('deleteMessage',{chat_id:target.chatId,message_id:messageId});
   },
  },
 };
}
