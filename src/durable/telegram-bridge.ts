import type { NativeConfig } from './config.js';
import { HostControlRejectedError, type HostControl, type HostTransport } from './host.js';
import type { SourceEnvelope, Target } from './ingress.js';
import type { createNativeTelegramTransport, TelegramUpdate } from './transport.js';
import { assertPresentation, clean, formatDiagnostics, modelMenu, parseCallbackData, parseCommandText, skillsList, statusMenu, thinkingMenu, unavailableText,
  type Buttons, type CallbackAction, type ControlCommand, type DiagnosticSection, type MenuState, type ModelChoice, type Presentation, type UiCommandName } from './telegram-ui.js';
import { createPreviewStream } from './telegram-stream.js';

export type RawTransport = Pick<ReturnType<typeof createNativeTelegramTransport>, 'start'|'stop'|'deliver'|'answerCallback'> &
  Partial<Pick<ReturnType<typeof createNativeTelegramTransport>, 'present'|'edit'|'preview'>>;
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
export type UiCommandRequest=UiOrigin&({name:UiCommandName;arg?:undefined}|{name:'selectModel';arg:string}|{name:'selectThinking';arg:string}|{name:'model';arg?:string});
export type UiConfirmationRequest=UiOrigin&{messageId:number;key:string;choice:'approve'|'deny'};
/** Parent-composed host side. Implementations must treat commandId as an idempotency key. */
export interface NativeUiController {
  command(request:UiCommandRequest):Promise<UiResult>;
  /** Resolve `key` to the persisted memory approval and decide with principal/target/messageId taken from this request, never from the key. */
  confirmation(request:UiConfirmationRequest):Promise<UiResult>;
}
export type TrustedCallback={id:string;commandId:string;actorId:number;principal:string;target:Target;messageId:number;data:string;action:CallbackAction|undefined};
export type NormalizedUpdate =
 |{type:'input';envelope:SourceEnvelope}
 |{type:'control';control:HostControl}
 |{type:'ui';origin:UiOrigin;name:UiCommandName}
 |{type:'callback';callback:TrustedCallback}
 |{type:'ignored'}
 |{type:'rejected';reason:string};
export const controlFor=(config:NativeConfig,updateId:number,type:ControlCommand):HostControl=>({type,requestId:`telegram-control:${config.transport.botId}:${updateId}`,principal:config.principal,target:{chatId:config.transport.allowedUserId}});
/** Private text and callback boundary. Full grouped/media and household surfaces are C6 gates. */
export function normalizeTelegramUpdate(config:NativeConfig,update:TelegramUpdate,commands?:ReadonlySet<string>):NormalizedUpdate {
 if(!integer(update.update_id)||update.update_id<0) throw new Error('Invalid Telegram update identity');
 const callback=object(update.callback_query);
 const message=object(callback?.message??update.message);
 if(!message) return {type:'ignored'};
 const from=object(callback?.from??message.from),chat=object(message.chat);
 if(from?.id!==config.transport.allowedUserId||from.is_bot===true||chat?.id!==config.transport.allowedUserId||chat.type!=='private')return {type:'ignored'};
 const target:Target={chatId:config.transport.allowedUserId};
 if(callback){
  if(typeof callback.id!=='string'||callback.id.length===0||callback.id.length>128)throw new Error('Invalid callback identity');
  if(!integer(message.message_id)||message.message_id<=0)throw new Error('Invalid callback message');
  const data=typeof callback.data==='string'?callback.data:'';
  const action=message.message_thread_id===undefined?parseCallbackData(data):undefined;
  return {type:'callback',callback:{id:callback.id,commandId:`telegram-callback:${config.transport.botId}:${update.update_id}`,actorId:config.transport.allowedUserId,principal:config.principal,target,messageId:message.message_id,data,action}};
 }
 if(!integer(message.message_id)||message.message_id<=0||!integer(message.date)||message.date<0)throw new Error('Invalid Telegram source');
 if(typeof message.text!=='string'||message.media_group_id!==undefined||message.photo!==undefined||message.document!==undefined||message.voice!==undefined)return {type:'rejected',reason:'This native foundation profile requires an ungrouped text message.'};
 if(message.message_thread_id!==undefined)return {type:'rejected',reason:'Thread input is unavailable on the private foundation surface.'};
 const parsed=parseCommandText(message.text,commands);
 if(parsed.type==='control')return {type:'control',control:controlFor(config,update.update_id,parsed.name)};
 if(parsed.type==='ui')return {type:'ui',name:parsed.name,origin:{commandId:`telegram-command:${config.transport.botId}:${update.update_id}`,principal:config.principal,actorId:config.transport.allowedUserId,target}};
 if(parsed.type==='unavailable')return {type:'rejected',reason:unavailableText(parsed)};
 return {type:'input',envelope:{instance:config.instanceId,principal:config.principal,bot:String(config.transport.botId),chatId:config.transport.allowedUserId,messageIds:[message.message_id],originalAt:message.date*1000,content:message.text}};
}
export function assertNativeEnvelope(config:NativeConfig,envelope:SourceEnvelope):void {
 if(envelope.instance!==config.instanceId||envelope.principal!==config.principal||envelope.bot!==String(config.transport.botId)||envelope.chatId!==config.transport.allowedUserId||envelope.threadId!==undefined||envelope.proactive===true||(envelope.attachments?.length??0)>0)throw new Error('Source is outside this instance authority');
}
export function assertNativeControl(config:NativeConfig,control:HostControl):void {
 if(control.principal!==config.principal||control.target.chatId!==config.transport.allowedUserId||control.target.threadId!==undefined||!control.requestId.startsWith(`telegram-control:${config.transport.botId}:`))throw new Error('Control is outside this instance authority');
}
export type NativeBridgeOptions={
 /** Slash/callback UI behavior. Without it only durable controls work and other commands are refused. */
 ui?:NativeUiController;
 /** Restrict enabled slash commands (profile visibility). Defaults to all. */
 commands?:readonly string[];
 previewIntervalMs?:number;
};
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
} {
 const allowed=(target:Target)=>target.chatId===config.transport.allowedUserId&&target.threadId===undefined;
 const only=(target:Target)=>{if(!allowed(target))throw Object.assign(new Error('Delivery target outside instance authority'),{definitelyNotSent:true});};
 const commands=options.commands?new Set(options.commands):undefined;
 const home:Target={chatId:config.transport.allowedUserId};
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
 async function runControl(control:HostControl,origin:{messageId?:number},callbackId?:string){
  try{await onControlRef(control);}
  catch(error){if(error instanceof HostControlRejectedError){if(callbackId)await answer(callbackId,error.message);else await reject(error.message);return;}throw error;}
  if(callbackId)await answer(callbackId);
  // A successful /new returns to the status menu.
  if(control.type==='new')await showMenu({commandId:`menu:${control.requestId}`,principal:control.principal,actorId:config.transport.allowedUserId,target:home,...(origin.messageId!==undefined?{messageId:origin.messageId}:{})});
 }
 let onControlRef:(control:HostControl)=>Promise<void>=async()=>{throw new Error('Bridge not started');};
 const streamer=createPreviewStream({authorize:allowed,...(options.previewIntervalMs!==undefined?{intervalMs:options.previewIntervalMs}:{}),
  send:(target,text)=>raw.preview?raw.preview(target,text):Promise.resolve(),onError:()=>{/* previews are best effort */}});
 const callbackFor=async(updateId:number,item:TrustedCallback)=>{
  const action=item.action;
  if(!action){await answer(item.id,'This action is unavailable.');return;}
  const origin:UiOrigin={commandId:item.commandId,principal:item.principal,actorId:item.actorId,target:item.target,messageId:item.messageId};
  switch(action.type){
   case 'control':return runControl(controlFor(config,updateId,action.name),origin,item.id);
   case 'menu':await runUi(updateId,{...origin,name:action.name==='menu'?'menu':action.name},item.id);return;
   case 'modelPage':await runUi(updateId,{...origin,name:'model',arg:String(action.page)},item.id);return;
   case 'model':case 'thinking':{
    const result=await runUi(updateId,{...origin,name:action.type==='model'?'selectModel':'selectThinking',arg:action.type==='model'?action.id:action.level} as UiCommandRequest,item.id);
    if(result)await showMenu(origin);   // Selection returns to the status menu.
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
 return {
  start:async(onEnvelope,onControl)=>{
   onControlRef=onControl;
   await raw.start({accept:async(update)=>{
    try{
     const item=normalizeTelegramUpdate(config,update,commands);
     if(item.type==='input')await onEnvelope(item.envelope);
     else if(item.type==='control')await runControl(item.control,{});
     else if(item.type==='ui')await runUi(update.update_id,{...item.origin,name:item.name},undefined);
     else if(item.type==='rejected')await reject(item.reason);
     else if(item.type==='callback')await callbackFor(update.update_id,item.callback);
    }catch(error){afterAck.delete(update.update_id);throw error;}
   },acknowledged:async(updateId:number)=>{
    const work=afterAck.get(updateId);afterAck.delete(updateId);
    for(const fn of work??[])await fn();
   },failed:onTransportFailure});
  },
  stop:async()=>{streamer.stop();await raw.stop();},
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
  stream:{update:(target,turn,text)=>streamer.update(target,turn,text),finish:(target,turn)=>streamer.finish(target,turn)},
 };
}
