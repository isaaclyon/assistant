import type { NativeConfig } from './config.js';
import { HostControlRejectedError, type HostControl, type HostTransport } from './host.js';
import type { SourceEnvelope } from './ingress.js';
import type { createNativeTelegramTransport, TelegramUpdate } from './transport.js';

export type RawTransport = Pick<ReturnType<typeof createNativeTelegramTransport>, 'start'|'stop'|'deliver'|'answerCallback'>;
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value);
export type NormalizedUpdate = {type:'input';envelope:SourceEnvelope}|{type:'control';control:HostControl}|{type:'callback';id:string}|{type:'ignored'}|{type:'rejected';reason:string};
/** C2 private text boundary. Full grouped/media and household surfaces are C6 gates. */
export function normalizeTelegramUpdate(config:NativeConfig,update:TelegramUpdate):NormalizedUpdate {
 if(!integer(update.update_id)||update.update_id<0) throw new Error('Invalid Telegram update identity');
 const callback=object(update.callback_query);
 const message=object(callback?.message??update.message);
 if(!message) return {type:'ignored'};
 const from=object(callback?.from??message.from),chat=object(message.chat);
 if(from?.id!==config.transport.allowedUserId||from.is_bot===true||chat?.id!==config.transport.allowedUserId||chat.type!=='private')return {type:'ignored'};
 if(callback){if(typeof callback.id!=='string')throw new Error('Invalid callback identity');return {type:'callback',id:callback.id};}
 if(!integer(message.message_id)||message.message_id<=0||!integer(message.date)||message.date<0)throw new Error('Invalid Telegram source');
 if(typeof message.text!=='string'||message.media_group_id!==undefined||message.photo!==undefined||message.document!==undefined||message.voice!==undefined)return {type:'rejected',reason:'This native foundation profile requires an ungrouped text message.'};
 if(message.message_thread_id!==undefined)return {type:'rejected',reason:'Thread input is unavailable on the private foundation surface.'};
 const command=message.text.trim();
 const type=({'/new':'new','/abort':'abort','/stop':'stop','/compact':'compact'} as const)[command as '/new'];
 if(type)return {type:'control',control:{type,requestId:`telegram-control:${config.transport.botId}:${update.update_id}`,principal:config.principal,target:{chatId:config.transport.allowedUserId}}};
 return {type:'input',envelope:{instance:config.instanceId,principal:config.principal,bot:String(config.transport.botId),chatId:config.transport.allowedUserId,messageIds:[message.message_id],originalAt:message.date*1000,content:message.text}};
}
export function assertNativeEnvelope(config:NativeConfig,envelope:SourceEnvelope):void {
 if(envelope.instance!==config.instanceId||envelope.principal!==config.principal||envelope.bot!==String(config.transport.botId)||envelope.chatId!==config.transport.allowedUserId||envelope.threadId!==undefined||envelope.proactive===true||(envelope.attachments?.length??0)>0)throw new Error('Source is outside this instance authority');
}
export function assertNativeControl(config:NativeConfig,control:HostControl):void {
 if(control.principal!==config.principal||control.target.chatId!==config.transport.allowedUserId||control.target.threadId!==undefined||!control.requestId.startsWith(`telegram-control:${config.transport.botId}:`))throw new Error('Control is outside this instance authority');
}
export function bridgeTelegram(config:NativeConfig,raw:RawTransport,onTransportFailure:(error:unknown)=>void):HostTransport {
 // Rejections are not accepted work. Their notices are best effort, so an
 // uncertain notice cannot cause a rejected update to block or execute later.
 const reject=async(reason:string)=>{try{await raw.deliver({chatId:config.transport.allowedUserId},reason);}catch(error){onTransportFailure(error);}};
 return {
  start:async(onEnvelope,onControl)=>{
   await raw.start({accept:async(update)=>{
    const item=normalizeTelegramUpdate(config,update);
    if(item.type==='input')await onEnvelope(item.envelope);
    else if(item.type==='control'){
     try{await onControl(item.control);}catch(error){if(error instanceof HostControlRejectedError)await reject(error.message);else throw error;}
    }
    else if(item.type==='rejected')await reject(item.reason);
    else if(item.type==='callback')await raw.answerCallback(item.id,'This action is unavailable in the foundation test.');
   },failed:onTransportFailure});
  },
  stop:()=>raw.stop(),
  sendFinal:async request=>{
   if(request.target.chatId!==config.transport.allowedUserId||request.target.threadId!==undefined)throw Object.assign(new Error('Delivery target outside instance authority'),{definitelyNotSent:true});
   const messageId=await raw.deliver(request.target,request.text);
   if(!integer(messageId)||messageId<=0)throw new Error('Telegram delivery receipt missing');
   return {messageId};
  },
 };
}
