import { createHash } from 'node:crypto';
import { defineDoc } from '@earendil-works/pi-durable';
import type { Model, Api, Provider, StreamOptions } from '@earendil-works/pi-ai';
import type { DurableHost } from './host.js';
import { HostControlRejectedError } from './host.js';
import { context } from './ingress.js';

/** Separate document leaves earlier profile state and recovery signatures intact. */
export const NativeFast = defineDoc({kind:'bridge.provider-fast',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({
 active:false as boolean,saved:false as boolean,commands:{} as Record<string,{fingerprint:string}>,
})});
export const supportsNativeFast=(model:Pick<Model<Api>,'provider'|'api'>)=>
 ['openai','openai-codex'].includes(model.provider)&&['openai-responses','openai-codex-responses'].includes(model.api);

/** A provider owns the wire option. SimpleStreamOptions discards serviceTier,
 * so compose its supported onPayload callback after native serialization. */
export function withNativeFast(provider:Provider,enabled:()=>Promise<boolean>):Provider {
 const options=(model:Model<Api>,input:StreamOptions|undefined):StreamOptions=>({
  ...input,
  onPayload:async(payload,m)=>{
   const transformed=await input?.onPayload?.(payload,m);
   const body=transformed??payload;
   if(!supportsNativeFast(model))return body;
   if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Invalid native provider request');
   const result={...body as Record<string,unknown>};
   // Host preference is authoritative; callers cannot silently override it.
   if(await enabled())result.service_tier='priority';else delete result.service_tier;
   return result;
  },
 });
 return {...provider,
  stream:(m,c,o)=>provider.stream(m,c,{...o,onPayload:options(m,o).onPayload} as typeof o),
  streamSimple:(m,c,o)=>provider.streamSimple(m,c,{...o,...options(m,o)}),
 };
}

/** Saved changes may arrive during a run. Only the host's acceptance line may
 * promote them after all native work settles, including retry timers. */
export function createNativeFast(options:{host():DurableHost;botId:number;model():Promise<Model<Api>|undefined>}) {
 const read=async()=>{const host=options.host();return await host.runtime.harness.snapshot(NativeFast,host.runtime.root.id,context)??{active:false as boolean,saved:false as boolean,commands:{}};};
 const supported=async()=>{const model=await options.model();return !!model&&supportsNativeFast(model);};
 async function settle(){
  const host=options.host();
  const inspection=await host.runtime.harness.inspect(context);
  if(inspection.tasks.length||inspection.submissions.length)return;
  const state=await read();
  if(state.active!==state.saved)await host.runtime.root.commit(async tx=>{const state=await tx.doc(NativeFast,host.runtime.root.id);state.active=state.saved;},context);
 }
 return {
  /** Called inside the serialized host line before buffered work is admitted. */
  settle,
  async active(){return (await read()).active;},
  async command(requestId:string,action:'on'|'off'|'status'){
   if(![`telegram-control:${options.botId}:`,`telegram-callback:${options.botId}:`,`telegram-command:${options.botId}:`].some(prefix=>requestId.startsWith(prefix)))throw new Error('Unauthenticated command identity');
   if(!['on','off','status'].includes(action))throw new HostControlRejectedError('Use /fast on, /fast off or /fast status.');
   return options.host().administration(async()=>{
    if(!await supported())throw new HostControlRejectedError('Fast mode is unavailable for the selected model.');
    if(action!=='status'){
     const host=options.host(),fingerprint=createHash('sha256').update(action).digest('hex');
     await host.runtime.root.commit(async tx=>{
      const state=await tx.doc(NativeFast,host.runtime.root.id),prior=state.commands[requestId];
      if(prior){if(prior.fingerprint!==fingerprint)throw new Error('Command identity conflict');return;}
      state.saved=action==='on';state.commands[requestId]={fingerprint};
     },context);
    }
    await settle();
    const state=await read();
    return `Fast mode\nActive: ${state.active?'on':'off'}\nSaved: ${state.saved?'on':'off'}${state.active!==state.saved?'\nPending: applies after current work settles.':''}\nPriority processing where supported; it may use more quota or cost more.`;
   });
  },
 };
}
