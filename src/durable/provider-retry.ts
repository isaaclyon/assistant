import type { AssistantMessage, AssistantMessageEvent, Model, Api, Provider, StreamOptions, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';

/**
 * Native retry compatibility for providers. Pi's Harness owns the retry budget and
 * backoff; this wrapper only (1) adds the legacy wording that the native matcher
 * lacks and (2) turns a silent provider into a terminal error so the Harness can
 * retry it. It never loops itself.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;
/** Time a provider gets to publish its own aborted result after an external abort. */
const ABORT_GRACE_MS = 250;
const LEGACY_RETRYABLE=/Unknown error \(no error details in response\)|websocket[_\s-]*connection[_\s-]*limit[_\s-]*reached|create a new websocket connection to continue/i;
/** Matches the native retryable list ("provider.?returned.?(an.?)?error"). */
const NATIVE_RETRY_HINT='provider returned error';

export interface NativeRetryOptions {
 /** Idle limit in ms between provider activity. 0 disables. Default 90000. */
 stallTimeoutMs?:number;
}

const zeroUsage=():AssistantMessage['usage']=>({input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const text=(error:unknown)=>error instanceof Error?error.message:String(error);

/** Adds the native retry hint to legacy transient errors; leaves everything else alone. */
export function normalizeRetryableError(message:AssistantMessage):AssistantMessage {
 if(message.stopReason!=='error'||!message.errorMessage||!LEGACY_RETRYABLE.test(message.errorMessage))return message;
 if(isRetryableAssistantError(message))return message;
 const normalized={...message,errorMessage:`${message.errorMessage} [${NATIVE_RETRY_HINT}]`};
 // Quota text keeps the native non-retryable verdict; return the original unchanged.
 return isRetryableAssistantError(normalized)?normalized:message;
}

const NONE=Symbol('no result');
type Start=(signal:AbortSignal)=>AssistantMessageEventStream;

function guarded(model:Model<Api>,start:Start,parent:AbortSignal|undefined,stallTimeoutMs:number):AssistantMessageEventStream {
 const output=new AssistantMessageEventStream();
 const child=new AbortController();
 let finished=false,partial:AssistantMessage|undefined,timer:ReturnType<typeof setTimeout>|undefined,grace:ReturnType<typeof setTimeout>|undefined;
 const blank=(stopReason:'error'|'aborted',errorMessage?:string):AssistantMessage=>({
  role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:partial?.usage??zeroUsage(),stopReason,
  ...errorMessage===undefined?{}:{errorMessage},timestamp:Date.now(),
 });
 const clear=()=>{if(timer)clearTimeout(timer);if(grace)clearTimeout(grace);timer=grace=undefined;parent?.removeEventListener('abort',onParent);};
 const finish=(message:AssistantMessage)=>{
  if(finished)return;
  finished=true;clear();
  // An obsolete stream may finish successfully after its caller cancelled it.
  // Cancellation remains terminal even when that provider ignores its signal.
  const final=parent?.aborted&&message.stopReason!=='aborted'?blank('aborted'):normalizeRetryableError(message);
  const type=final.stopReason==='error'||final.stopReason==='aborted';
  output.push(type?{type:'error',reason:final.stopReason as 'error'|'aborted',error:final}:{type:'done',reason:final.stopReason as 'stop',message:final});
  output.end(final);
 };
 const abandon=()=>{if(!child.signal.aborted)child.abort();};
 const arm=()=>{
  if(stallTimeoutMs<=0||finished||parent?.aborted)return;
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{
   if(finished)return;
   abandon();
   finish(blank('error',`Provider stream timed out after ${stallTimeoutMs}ms without activity`));
  },stallTimeoutMs);
  timer.unref?.();
 };
 function onParent(){
  if(finished)return;
  abandon();
  if(timer)clearTimeout(timer);timer=undefined;
  // A provider normally reports its own aborted message; synthesize one if it stays silent.
  grace=setTimeout(()=>finish(blank('aborted')),ABORT_GRACE_MS);grace.unref?.();
 }
 if(parent?.aborted){finish(blank('aborted'));return output;}
 parent?.addEventListener('abort',onParent,{once:true});
 arm();
 let source:AssistantMessageEventStream;
 try{source=start(child.signal);}
 catch(error){finish(blank(parent?.aborted?'aborted':'error',text(error)));return output;}
 // The source may reject its result after we stopped listening.
 source.result().catch(()=>{});
 void (async()=>{
  const iterator=source[Symbol.asyncIterator]();
  try{
   for(;;){
    const next=await iterator.next();
    if(finished)return;
    if(next.done)break;
    const event:AssistantMessageEvent=next.value;
    if('partial' in event)partial=event.partial;
    if(event.type==='done'){finish(event.message);return;}
    if(event.type==='error'){finish(event.error);return;}
    arm();
    output.push(event);
   }
   // Stream ended without a terminal event; its result may still carry one.
   // end() without a result leaves result() pending, so settled results win a race against NONE.
   const message=await Promise.race([source.result(),Promise.resolve(NONE)]);
   finish(message===NONE?blank('error','Provider stream ended without a result'):message);
  }catch(error){
   finish(blank(parent?.aborted?'aborted':'error',text(error)));
  }finally{
   if(finished)void Promise.resolve(iterator.return?.()).catch(()=>{});
  }
 })();
 return output;
}

export function withNativeRetry(provider:Provider,options:NativeRetryOptions={}):Provider {
 const stall=options.stallTimeoutMs??DEFAULT_STALL_TIMEOUT_MS;
 if(!Number.isInteger(stall)||stall<0||stall>2_147_483_647)throw new RangeError('stallTimeoutMs must be an integer between 0 and 2147483647');
 return {...provider,
  stream:(m:Model<Api>,c:TranscriptContext,o?:StreamOptions)=>guarded(m,signal=>provider.stream(m,c,{...o,signal}),o?.signal,stall),
  streamSimple:(m:Model<Api>,c:TranscriptContext,o?:SimpleStreamOptions)=>guarded(m,signal=>provider.streamSimple(m,c,{...o,signal}),o?.signal,stall),
 };
}
