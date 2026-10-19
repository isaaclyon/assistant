import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, type AssistantMessage, type AssistantMessageEvent, type Provider, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost } from '../../src/durable/host.js';
import { withNativeRetry } from '../../src/durable/provider-retry.js';

const cleanup:Array<()=>Promise<unknown>>=[];
beforeEach(()=>{vi.useFakeTimers();});
afterEach(async()=>{
 if(vi.isFakeTimers())expect(vi.getTimerCount(),'pending timers').toBe(0);
 vi.useRealTimers();
 for(const fn of cleanup.splice(0).reverse())await fn();
});

const faux=fauxProvider();
const model=faux.getModel();
const context={messages:[{role:'user',content:'hi',timestamp:0}]} as unknown as TranscriptContext;
const msg=(text:string,over:Partial<AssistantMessage>={}):AssistantMessage=>({...fauxAssistantMessage(text),...over});
const partialText=(text:string)=>({type:'text_delta',contentIndex:0,delta:text,partial:msg(text)}) as AssistantMessageEvent;
type Script=(stream:AssistantMessageEventStream,signal:AbortSignal|undefined,options:SimpleStreamOptions|undefined)=>void;
function provider(script:Script,seen:{signals:(AbortSignal|undefined)[];calls:number}={signals:[],calls:0}):Provider {
 const start=(_m:unknown,_c:unknown,o?:SimpleStreamOptions)=>{seen.calls++;seen.signals.push(o?.signal);const s=new AssistantMessageEventStream();script(s,o?.signal,o);return s;};
 return {...faux.provider,stream:start as never,streamSimple:start as never};
}
async function drain(stream:AssistantMessageEventStream){
 const events:AssistantMessageEvent[]=[];
 for await(const e of stream)events.push(e);
 return {events,result:await stream.result()};
}
const terminals=(events:AssistantMessageEvent[])=>events.filter(e=>e.type==='done'||e.type==='error');

test('legacy transient wording becomes natively retryable; quota and aborts stay as they were',async()=>{
 const run=async(stopReason:'error'|'aborted',errorMessage:string)=>{
  const p=withNativeRetry(provider(s=>{const m=msg('',{stopReason,errorMessage});s.push({type:'error',reason:stopReason,error:m});s.end(m);}));
  return (await drain(p.streamSimple(model,context))).result;
 };
 for(const text of ['Unknown error (no error details in response)','Codex websocket_connection_limit_reached','Please create a new websocket connection to continue']){
  const r=await run('error',text);expect(r.errorMessage).toContain(text);expect(isRetryableAssistantError(r),text).toBe(true);
 }
 const quota=await run('error','Unknown error (no error details in response): quota exceeded');
 expect(isRetryableAssistantError(quota)).toBe(false);expect(quota.errorMessage).toBe('Unknown error (no error details in response): quota exceeded');
 const plain=await run('error','invalid api key');expect(plain.errorMessage).toBe('invalid api key');
 const aborted=await run('aborted','Unknown error (no error details in response)');expect(aborted.stopReason).toBe('aborted');expect(aborted.errorMessage).toBe('Unknown error (no error details in response)');
 const already=await run('error','503 service unavailable');expect(already.errorMessage).toBe('503 service unavailable');
});

test('successful streams pass events through unchanged with one terminal and no pending timer',async()=>{
 const final=msg('ok');
 const p=withNativeRetry(provider(s=>{s.push({type:'start',partial:msg('')});s.push(partialText('ok'));s.push({type:'done',reason:'stop',message:final});}),{stallTimeoutMs:1000});
 const {events,result}=await drain(p.stream(model,context));
 expect(events.map(e=>e.type)).toEqual(['start','text_delta','done']);expect(result).toBe(final);
 expect(vi.getTimerCount()).toBe(0);
});

test('periodic deltas prevent an idle timeout while a total deadline would have expired',async()=>{
 const p=withNativeRetry(provider(s=>{
  s.push({type:'start',partial:msg('')});
  let n=0;const tick=setInterval(()=>{n++;s.push(partialText('x'));if(n===5){clearInterval(tick);s.push({type:'done',reason:'stop',message:msg('xxxxx')});}},400);
 }),{stallTimeoutMs:500});
 const pending=drain(p.streamSimple(model,context));
 await vi.advanceTimersByTimeAsync(2100); // 2.1s total, over the 500ms idle limit
 const {result}=await pending;
 expect(result.stopReason).toBe('stop');
});

test('silence from the start times out as a retryable error, aborts the provider and ignores a late success',async()=>{
 const seen={signals:[] as (AbortSignal|undefined)[],calls:0};let late!:()=>void;
 const parent=new AbortController();
 const p=withNativeRetry(provider(s=>{late=()=>{s.push({type:'done',reason:'stop',message:msg('late')});s.end(msg('late'));};},seen),{stallTimeoutMs:1000});
 const pending=drain(p.streamSimple(model,context,{signal:parent.signal}));
 await vi.advanceTimersByTimeAsync(1000);
 const {events,result}=await pending;
 expect(result.stopReason).toBe('error');expect(isRetryableAssistantError(result)).toBe(true);
 expect(terminals(events)).toHaveLength(1);
 expect(seen.signals[0]).not.toBe(parent.signal);expect(seen.signals[0]!.aborted).toBe(true);expect(parent.signal.aborted).toBe(false);
 late();await vi.advanceTimersByTimeAsync(10);
 expect(terminals(events)).toHaveLength(1);expect((await p.streamSimple(model,context,{signal:AbortSignal.abort()}).result()).stopReason).toBe('aborted');
});

test('a late tool call after idle expiry is discarded',async()=>{
 let push!:(e:AssistantMessageEvent)=>void;
 const p=withNativeRetry(provider(s=>{push=e=>s.push(e);s.push({type:'start',partial:msg('')});}),{stallTimeoutMs:100});
 const pending=drain(p.streamSimple(model,context));
 await vi.advanceTimersByTimeAsync(100);
 push({type:'toolcall_end',contentIndex:0,toolCall:{type:'toolCall',id:'t',name:'x',arguments:{}},partial:msg('')} as AssistantMessageEvent);
 push({type:'done',reason:'toolUse',message:msg('',{stopReason:'toolUse'})});
 const {events,result}=await pending;
 expect(result.stopReason).toBe('error');expect(events.map(e=>e.type)).toEqual(['start','error']);
});

test('external abort stays aborted, aborts the child only, and a silent provider still ends',async()=>{
 const parent=new AbortController();const seen={signals:[] as (AbortSignal|undefined)[],calls:0};
 const p=withNativeRetry(provider(s=>{s.push({type:'start',partial:msg('partial')});},seen),{stallTimeoutMs:60_000});
 const pending=drain(p.streamSimple(model,context,{signal:parent.signal}));
 await vi.advanceTimersByTimeAsync(10);
 parent.abort();
 await vi.advanceTimersByTimeAsync(300);
 const {events,result}=await pending;
 expect(result.stopReason).toBe('aborted');expect(isRetryableAssistantError(result)).toBe(false);
 expect(terminals(events)).toHaveLength(1);expect(seen.signals[0]!.aborted).toBe(true);expect(seen.calls).toBe(1);
});

test('external abort cannot turn into a late success or retryable error during the grace period',async()=>{
 for(const terminal of ['stop','error'] as const){
  const parent=new AbortController();let late!:()=>void;
  const p=withNativeRetry(provider(s=>{late=()=>{const m=msg('obsolete',{stopReason:terminal,errorMessage:'503 unavailable'});if(terminal==='stop')s.push({type:'done',reason:'stop',message:m});else s.push({type:'error',reason:'error',error:m});};}),{stallTimeoutMs:1000});
  const pending=drain(p.streamSimple(model,context,{signal:parent.signal}));parent.abort();late();
  const {events,result}=await pending;expect(result.stopReason).toBe('aborted');expect(terminals(events)).toHaveLength(1);expect(isRetryableAssistantError(result)).toBe(false);
 }
});

test('a provider that reports its own aborted message keeps it',async()=>{
 const parent=new AbortController();const own=msg('kept',{stopReason:'aborted'});
 const p=withNativeRetry(provider((s,signal)=>{signal!.addEventListener('abort',()=>{s.push({type:'error',reason:'aborted',error:own});s.end(own);});}),{stallTimeoutMs:60_000});
 const pending=drain(p.streamSimple(model,context,{signal:parent.signal}));
 parent.abort();
 expect((await pending).result).toBe(own);
});

test('streams that end without a terminal event use their result, or fail retryably',async()=>{
 const resultOnly=msg('via result');
 const a=withNativeRetry(provider(s=>{s.push(partialText('x'));s.end(resultOnly);}));
 expect((await drain(a.streamSimple(model,context))).result.stopReason).toBe('stop');
 const b=withNativeRetry(provider(s=>{s.end();}));
 const r=(await drain(b.streamSimple(model,context))).result;
 expect(r.stopReason).toBe('error');expect(isRetryableAssistantError(r)).toBe(true);
});

test('synchronous throws and rejected results become one error without unhandled rejections',async()=>{
 const unhandled=vi.fn();process.on('unhandledRejection',unhandled);
 try{
  const p1=withNativeRetry({...faux.provider,stream:(()=>{throw new Error('503 service unavailable');}) as never,streamSimple:(()=>{throw new Error('503 service unavailable');}) as never});
  for(const run of [()=>p1.stream(model,context),()=>p1.streamSimple(model,context)]){
   const {events,result}=await drain(run());
   expect(terminals(events)).toHaveLength(1);expect(isRetryableAssistantError(result)).toBe(true);
  }
  const bad=new AssistantMessageEventStream();
  (bad as unknown as {result:()=>Promise<never>}).result=()=>Promise.reject(new Error('socket hang up'));
  const p2=withNativeRetry({...faux.provider,stream:(()=>bad) as never,streamSimple:(()=>bad) as never});
  bad.end();
  const r=(await drain(p2.streamSimple(model,context))).result;
  expect(r.stopReason).toBe('error');expect(isRetryableAssistantError(r)).toBe(true);
  await vi.advanceTimersByTimeAsync(10);await Promise.resolve();
  expect(unhandled).not.toHaveBeenCalled();
 }finally{process.off('unhandledRejection',unhandled);}
});

test('stallTimeoutMs of 0 disables the watchdog; invalid values are rejected',async()=>{
 for(const stallTimeoutMs of [-1,0.5,NaN,Infinity,2**31])expect(()=>withNativeRetry(faux.provider,{stallTimeoutMs})).toThrow(RangeError);
 const p=withNativeRetry(provider(s=>{setTimeout(()=>{s.push({type:'done',reason:'stop',message:msg('slow')});},10 * 60_000);}),{stallTimeoutMs:0});
 const pending=drain(p.streamSimple(model,context));
 await vi.advanceTimersByTimeAsync(10 * 60_000);
 expect((await pending).result.stopReason).toBe('stop');
});

async function harness(retry:{enabled:boolean;maxRetries?:number},script:(call:number)=>Script){
 vi.useRealTimers();
 const dir=await mkdtemp(join(tmpdir(),'native-retry-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
 const seen={signals:[] as (AbortSignal|undefined)[],calls:0};
 const inner=provider((s,signal,o)=>script(seen.calls)(s,signal,o),seen);
 const models=createModels();models.setProvider(withNativeRetry(inner,{stallTimeoutMs:80}));
 const finals:string[]=[];
 const host=await DurableHost.create({stateDir:dir,models,registry:createRegistry(),agent:{model:{provider:faux.provider.id,modelId:model.id}},settings:{retry:{...retry,baseDelayMs:1,maxAgentDelayMs:1},compaction:{enabled:false}},compatibility:{runtimeGeneration:'fixture',releaseSchema:1,profile:'fixture',registrySignature:'fixture'},policy(){},controlPolicy(){},transport:{async start(){},async stop(){},async sendFinal(r){finals.push(r.text);return {messageId:finals.length};}}});
 cleanup.push(()=>host.close());
 await host.start();
 await host.receive({instance:'fixture',principal:'isaac',bot:'1',chatId:1,messageIds:[1],originalAt:1,content:'go'});
 return {seen,finals};
}
const fail=(errorMessage:string):Script=>s=>{const m=msg('',{stopReason:'error',errorMessage});s.push({type:'error',reason:'error',error:m});s.end(m);};
const succeed=(text:string):Script=>s=>{const m=msg(text);s.push({type:'done',reason:'stop',message:m});s.end(m);};

test('actual Harness retries the legacy error and a stalled stream within its own budget',async()=>{
 const {seen,finals}=await harness({enabled:true,maxRetries:2},call=>call===1?fail('Unknown error (no error details in response)'):call===2?()=>{}:succeed('RECOVERED'));
 await vi.waitFor(()=>expect(finals).toEqual(['RECOVERED']),{timeout:10_000});
 expect(seen.calls).toBe(3);
});

test('actual Harness stops at the native budget and when retry is disabled',async()=>{
 const budget=await harness({enabled:true,maxRetries:1},()=>fail('Unknown error (no error details in response)'));
 await vi.waitFor(()=>expect(budget.seen.calls).toBe(2),{timeout:10_000});
 await new Promise(r=>setTimeout(r,200));expect(budget.seen.calls).toBe(2);
 const off=await harness({enabled:false},()=>fail('Unknown error (no error details in response)'));
 await vi.waitFor(()=>expect(off.seen.calls).toBe(1),{timeout:10_000});
 await new Promise(r=>setTimeout(r,200));expect(off.seen.calls).toBe(1);
});
