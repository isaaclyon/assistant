/** Single policy table for native capability profiles. Application, config,
 * authority, bridge and domain modules read this table instead of keeping
 * their own profile-name lists. */
export type NativePrincipal='isaac'|'emma'|'household'|'engineering';
export type NativeJobsRole='disabled'|'recipient'|'coordinator';
export interface NativeProfilePolicy {
 readonly id:string;
 readonly principals:readonly NativePrincipal[];
 readonly surface:'private'|'group';
 /** canonical: memory tools, core memory and history. history: session search only, no memory notes. none: foundation. */
 readonly memory:'none'|'canonical'|'history';
 readonly general:boolean; readonly google:boolean; readonly cli:boolean; readonly places:boolean; readonly mutations:boolean; readonly mediaStack:boolean;
 readonly browser:boolean; readonly provider:boolean; readonly parity:boolean; readonly children:boolean;
 readonly jobsRoles:readonly NativeJobsRole[];
 readonly schedules:'forbidden'|'required'|'optional';
 /** Exact credential scope per principal when the profile enforces one. */
 readonly credentialScopes?:Partial<Record<NativePrincipal,string>>;
 /** Slash commands owned by this profile beyond the shared set. */
 readonly commands?:readonly string[];
 /** Accept Telegram media from authenticated human actors. Only the full durable profiles enable it. */
 readonly media?:boolean;
}
const none={general:false,google:false,cli:false,places:false,mutations:false,mediaStack:false,browser:false,provider:false,parity:false,children:false};
type Features=typeof none;
const PERSONAL:readonly NativePrincipal[]=['isaac','emma','household'];
const level=(id:string,memory:NativeProfilePolicy['memory'],features:Partial<Features>,role:NativeJobsRole='disabled',schedules:NativeProfilePolicy['schedules']='forbidden',principals:readonly NativePrincipal[]=PERSONAL):NativeProfilePolicy=>
 ({id,principals,surface:'private',memory,...none,...features,jobsRoles:[role],schedules});
const ISAAC:readonly NativePrincipal[]=['isaac'];
const POLICIES:readonly NativeProfilePolicy[]=[
 level('durable-foundation-test','none',{},'disabled','forbidden',['isaac','emma','household','engineering']),
 level('durable-chat-memory-test','canonical',{}),
 level('durable-tools-test','canonical',{general:true}),
 level('durable-read-integrations-test','canonical',{general:true,google:true}),
 level('durable-cli-integrations-test','canonical',{general:true,google:true,cli:true}),
 level('durable-places-test','canonical',{general:true,google:true,cli:true,places:true},'disabled','forbidden',ISAAC),
 level('durable-mutations-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true},'disabled','forbidden',ISAAC),
 level('durable-browser-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true,browser:true},'disabled','forbidden',ISAAC),
 level('durable-provider-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true,browser:true,provider:true},'disabled','forbidden',ISAAC),
 level('durable-parity-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true,browser:true,provider:true,parity:true},'disabled','forbidden',ISAAC),
 level('durable-jobs-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true,browser:true,provider:true,parity:true},'recipient','forbidden',ISAAC),
 level('durable-jobs-coordinator-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true,browser:true,provider:true,parity:true},'coordinator','forbidden',ISAAC),
 level('durable-jobs-schedules-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true,browser:true,provider:true,parity:true},'coordinator','required',ISAAC),
 level('durable-jobs-children-test','canonical',{general:true,google:true,cli:true,places:true,mutations:true,browser:true,provider:true,parity:true,children:true},'coordinator','required',ISAAC),
 // Production-equivalent profiles. Each mirrors its legacy resource selection.
 {id:'durable-personal-isaac',media:true,principals:['isaac'],surface:'private',memory:'canonical',general:true,google:true,cli:true,places:true,mutations:true,mediaStack:true,browser:true,provider:true,parity:true,children:true,
  jobsRoles:['disabled','recipient','coordinator'],schedules:'optional',credentialScopes:{isaac:'isaac-personal'}},
 {id:'durable-personal-emma',media:true,principals:['emma'],surface:'private',memory:'canonical',general:true,google:false,cli:true,places:false,mutations:false,mediaStack:false,browser:true,provider:true,parity:true,children:true,
  jobsRoles:['disabled','recipient','coordinator'],schedules:'optional',credentialScopes:{emma:'emma-personal'}},
 {id:'durable-household-shared',media:true,principals:['household'],surface:'group',memory:'canonical',general:true,google:false,cli:true,places:false,mutations:false,mediaStack:false,browser:false,provider:true,parity:true,children:true,
  jobsRoles:['disabled','recipient','coordinator'],schedules:'optional'},
 {id:'durable-builder',media:true,principals:['engineering'],surface:'private',memory:'history',general:true,google:false,cli:false,places:false,mutations:false,mediaStack:true,browser:true,provider:true,parity:true,children:true,
  jobsRoles:['disabled','recipient','coordinator'],schedules:'optional',credentialScopes:{engineering:'engineering'},commands:['deploy']},
];
const BY_ID=new Map(POLICIES.map(policy=>[policy.id,policy]));
export const NATIVE_PROFILE_IDS:readonly string[]=POLICIES.map(policy=>policy.id);
export const profilePolicy=(id:string):NativeProfilePolicy|undefined=>BY_ID.get(id);
export function requireProfilePolicy(id:string):NativeProfilePolicy {
 const policy=BY_ID.get(id);if(!policy)throw new Error('Unsupported native capability profile');return policy;
}
export const isDomainProfile=(id:string)=>(BY_ID.get(id)?.memory??'none')!=='none';
export const isNativeMemoryProfile=(id:string)=>BY_ID.get(id)?.memory==='canonical';
