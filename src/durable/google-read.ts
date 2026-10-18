import { StringEnum, Type, validateToolArguments } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { executeGoogleRead, type GoogleReadOptions } from '../../.pi/lib/google-workspace-reads.js';
import { hasGogRuntime, runGogJson, type GoogleRuntime } from '../../.pi/lib/google-transport.js';
import type { NativeConfig } from './config.js';
import { textToolResult, type NativeBundle } from './registry.js';

const account=Type.Optional(Type.String({minLength:1,maxLength:254}));
const maximum=(max:number)=>Type.Optional(Type.Integer({minimum:1,maximum:max}));
const calendars=Type.Optional(Type.Array(Type.String({minLength:1,maxLength:1024}),{minItems:1,maxItems:20}));
const window={from:Type.String({minLength:10,maxLength:64}),to:Type.String({minLength:10,maxLength:64})};
const locale={language:Type.Optional(Type.String({minLength:2,maxLength:35})),region:Type.Optional(Type.String({minLength:2,maxLength:2}))};
const calendar=Type.Optional(StringEnum(['personal','things_to_do'] as const));
const profile=StringEnum(['identity','rich_details'] as const);
const operationNames=['account_status','calendar_event','calendar_list','calendar_events','calendar_search','calendar_availability','gmail_search','gmail_thread','contacts_search','places_search','places_search_candidates','places_details'] as const;
const object=<T extends Parameters<typeof Type.Object>[0]>(properties:T)=>Type.Object(properties,{additionalProperties:false});
export const googleReadParameters=Type.Union([
 object({operation:Type.Literal('account_status'),account}),
 object({operation:Type.Literal('calendar_event'),account,calendar,event_id:Type.String({minLength:1,maxLength:1024})}),
 object({operation:Type.Literal('calendar_list'),account,max_results:maximum(100)}),
 object({operation:Type.Literal('calendar_events'),account,calendar_ids:calendars,...window,time_zone:Type.Optional(Type.String({minLength:1,maxLength:64})),max_results:maximum(100)}),
 object({operation:Type.Literal('calendar_search'),account,calendar_ids:calendars,...window,time_zone:Type.Optional(Type.String({minLength:1,maxLength:64})),query:Type.String({minLength:1,maxLength:200}),max_results:maximum(100)}),
 object({operation:Type.Literal('calendar_availability'),accounts:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:254}),{minItems:1,maxItems:8})),calendar_ids:calendars,...window}),
 object({operation:Type.Literal('gmail_search'),account,query:Type.String({minLength:1,maxLength:500}),max_results:maximum(50)}),
 object({operation:Type.Literal('gmail_thread'),account,thread_id:Type.String({minLength:1,maxLength:256})}),
 object({operation:Type.Literal('contacts_search'),account,query:Type.String({minLength:1,maxLength:200}),max_results:maximum(10)}),
 object({operation:Type.Literal('places_search'),field_profile:Type.Literal('identity'),query:Type.String({minLength:1,maxLength:200}),...locale}),
 object({operation:Type.Literal('places_search_candidates'),query:Type.String({minLength:1,maxLength:200}),max_results:maximum(15),...locale}),
 object({operation:Type.Literal('places_details'),field_profile:profile,place_id:Type.String({minLength:1,maxLength:263}),...locale}),
]);
// Keep the provider wire root flat (C3 provider acceptance); validate the exact
// operation branch before the domain sees any input or starts a transport.
const wireParameters=object({operation:StringEnum(operationNames),account,accounts:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:254}),{minItems:1,maxItems:8})),calendar_ids:calendars,
 from:Type.Optional(window.from),to:Type.Optional(window.to),time_zone:Type.Optional(Type.String({minLength:1,maxLength:64})),calendar,event_id:Type.Optional(Type.String({minLength:1,maxLength:1024})),
 query:Type.Optional(Type.String({minLength:1,maxLength:500})),max_results:maximum(100),thread_id:Type.Optional(Type.String({minLength:1,maxLength:256})),field_profile:Type.Optional(profile),place_id:Type.Optional(Type.String({minLength:1,maxLength:263})),...locale});

export function nativeGoogleRuntime(config:NativeConfig):GoogleRuntime {
 const selected=config.google;if(!selected)throw new Error('Google reads require explicit instance configuration');
 return {stateDir:config.stateDir,...(selected.account?{account:selected.account}:{}),
  ...(selected.gog?{binary:selected.gog.binary,passwordFile:selected.gog.passwordFile,gogHome:selected.gog.home}:{}),
  ...(selected.calendarTargets?{calendarWrites:{...selected.calendarTargets}}:{}),
  ...(selected.places?{placesApiKeyFile:selected.places.apiKeyFile,placesSearchMonthlyLimit:selected.places.searchMonthlyLimit,placesDetailsMonthlyLimit:selected.places.detailsMonthlyLimit,placesCandidatesMonthlyLimit:selected.places.candidatesMonthlyLimit}:{}),
 };
}
const description='Read configured Google Calendar, Gmail and Contacts, or use bounded, locally metered Google Maps Places lookup. Only the listed read operations are available; no Calendar, mailbox or contact mutation, raw command or API access.';
const failure=(code:string,message:string)=>textToolResult({ok:false,result:null,error:{code,message}},true);
export function createGoogleReadBundle(config:NativeConfig,overrides:Partial<GoogleReadOptions>={}):NativeBundle {
 const runtime=nativeGoogleRuntime(config);
 const options:GoogleReadOptions={...overrides,run:overrides.run??(async(runtime,args,signal)=>{
  if(!hasGogRuntime(runtime))throw new Error('Google Workspace is unavailable');
  // A second boundary protects even future read-handler changes from accidentally
  // dispatching mutating CLI flags through this replay-safe tool.
  if(!args.includes('--readonly')||!args.includes('--no-input')||!args.includes('--gmail-no-send')||args.some(arg=>arg==='--force'||arg==='--allow-write'))throw new Error('Read-only Google command required');
  return runGogJson({binary:runtime.binary,passwordFile:runtime.passwordFile,gogHome:runtime.gogHome,args,signal});
 })};
 const placesParameters=Type.Union(googleReadParameters.anyOf.slice(-3));
 const placesTool=defineTool({name:'google_places_read',description:'Internal metered Places read; called by google_workspace.',parameters:wireParameters,replay:'unsafe',callers:['tools'],
  execute:async(raw,_api,context)=>{
   try{validateToolArguments({name:'google_places_read',description:'Internal Places read',parameters:placesParameters},{type:'toolCall',id:'validation',name:'google_places_read',arguments:raw});}catch{return failure('GOOGLE_INPUT_INVALID','The Places read request is invalid');}
   return executeRead(raw,context);
  },
 });
 async function executeRead(input:Record<string,unknown>,context:import('@earendil-works/chord/context').Context){
  const timeout=AbortSignal.timeout(30_000),signal=context.abortSignal?AbortSignal.any([context.abortSignal,timeout]):timeout;
  try{
   signal.throwIfAborted();
   const result=await executeGoogleRead(input,runtime,options,signal);
   signal.throwIfAborted();
   return result.ok?textToolResult(JSON.stringify({ok:true,result:result.result,error:null})):failure(result.code,result.message);
  }catch(error){
   if(context.abortSignal?.aborted)throw error;
   return timeout.aborted?failure('GOOGLE_READ_TIMEOUT','Google read timed out'):failure('GOOGLE_WORKSPACE_UNAVAILABLE','Google Workspace is temporarily unavailable');
  }
 }
 return {name:'google-reads',version:1,tools:[{version:1,tool:defineTool({name:'google_workspace',description,parameters:wireParameters,replay:'safe',
  execute:async(raw,api,context)=>{
   let input:Record<string,unknown>;
   try{input=validateToolArguments({name:'google_workspace',description,parameters:googleReadParameters},{type:'toolCall',id:'validation',name:'google_workspace',arguments:raw}) as Record<string,unknown>;}catch{return failure('GOOGLE_INPUT_INVALID','The Google read request is invalid');}
   // The outer dispatcher can replay. The nested Places task owns its unsafe
   // intent, so recovery returns interruption rather than reserving another
   // billable attempt after an uncertain fetch. Current authority wraps both.
   if(String(input.operation).startsWith('places_')){
    const nested=await api.executeTool('google_places_read',input as Parameters<ToolExecutionApi['executeTool']>[1],context,{key:'places-read',progress:false});
    return nested.structuredOutput===undefined?failure('GOOGLE_PLACES_INTERRUPTED','Places lookup was interrupted; an outbound attempt may already be counted'):textToolResult(nested.structuredOutput,nested.isError);
   }
   return executeRead(input,context);
  },
 })},{version:1,tool:placesTool}],close:async()=>{}};
}
