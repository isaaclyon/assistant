import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import { activateIsolatedDeployment, type IsolatedDeploymentOperations } from '../isolated-deployment.js';
import { digestTree } from '../recovery-snapshot.js';

export type RuntimeSelection = {
 instanceId:string;runtime:'legacy'|'pi-durable';releaseSha:string;nativeConfigPath?:string;
};
/** Private administrator input. The broker selects its release independently.
 * A stage changes one runtime; shared writers can stop and restart at their
 * existing selections under the same coordinated maintenance hold. */
export interface RuntimeActivation {
 version:1;stageId:string;selectedInstance:string;releaseRoot:string;brokerReleaseSha:string;
 observationMs:number;previous:RuntimeSelection[];desired:RuntimeSelection[];
}
export interface CanaryObservation {
 version:1;stageId:string;instanceId:string;releaseSha:string;startedAt:number;
 initialReady:{at:number;pid:number};restartReady:{at:number;pid:number};
 scheduledWork:{at:number;dispatchId:string;submissionId:string;outcome:'done'};
 observedUntil:number;evidenceDigest:string;
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,required:string[],optional:string[]=[])=>required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const path=(v:unknown):v is string=>typeof v==='string'&&isAbsolute(v)&&normalize(v)===v&&v!=='/'&&!/[\0\r\n\s%$"\\]/.test(v);
const same=(a:RuntimeSelection,b:RuntimeSelection)=>a.instanceId===b.instanceId&&a.runtime===b.runtime&&a.releaseSha===b.releaseSha&&a.nativeConfigPath===b.nativeConfigPath;
const ordered=(items:RuntimeSelection[])=>[...items].sort((a,b)=>a.instanceId.localeCompare(b.instanceId));
export const sameRuntimeMap=(a:RuntimeSelection[],b:RuntimeSelection[])=>a.length===b.length&&ordered(a).every((entry,index)=>same(entry,ordered(b)[index]!));
export function runtimeActivationDigest(plan:RuntimeActivation):string {
 const map=(entries:RuntimeSelection[])=>ordered(entries).map(entry=>[entry.instanceId,entry.runtime,entry.releaseSha,entry.nativeConfigPath??null]);
 return createHash('sha256').update(JSON.stringify([plan.version,plan.stageId,plan.selectedInstance,plan.releaseRoot,plan.brokerReleaseSha,plan.observationMs,map(plan.previous),map(plan.desired)])).digest('hex');
}
function selection(v:unknown):v is RuntimeSelection {
 return object(v)&&keys(v,['instanceId','runtime','releaseSha'],['nativeConfigPath'])&&id(v.instanceId)&&sha(v.releaseSha)&&
  (v.runtime==='legacy'?v.nativeConfigPath===undefined:v.runtime==='pi-durable'&&path(v.nativeConfigPath));
}
/** Pure validation does not read private configurations or import release code. */
export function parseRuntimeActivation(value:unknown,instanceIds:readonly string[]):RuntimeActivation {
 if(!object(value)||!keys(value,['version','stageId','selectedInstance','releaseRoot','brokerReleaseSha','observationMs','previous','desired'])||value.version!==1||
  !digest(value.stageId)||!id(value.selectedInstance)||!path(value.releaseRoot)||!sha(value.brokerReleaseSha)||
  !Number.isSafeInteger(value.observationMs)||Number(value.observationMs)<1||Number(value.observationMs)>30*24*60*60_000||
  !Array.isArray(value.previous)||!Array.isArray(value.desired)||!instanceIds.length||instanceIds.length>64||new Set(instanceIds).size!==instanceIds.length||!instanceIds.every(id))throw new Error('Invalid runtime activation mapping');
 for(const list of [value.previous,value.desired])if(list.length!==instanceIds.length||!list.every(selection)||new Set(list.map(s=>s.instanceId)).size!==list.length||list.some(s=>!instanceIds.includes(s.instanceId)))throw new Error('Runtime mapping must account for every configured instance exactly once');
 const p=value as unknown as RuntimeActivation;
 let changed=0;
 for(const desired of p.desired){
  const previous=p.previous.find(s=>s.instanceId===desired.instanceId)!;
  if(same(previous,desired))continue;
  changed++;
  if(desired.instanceId!==p.selectedInstance||desired.runtime!=='pi-durable'||previous.releaseSha===desired.releaseSha)throw new Error('A stage changes only its selected instance to a distinct reviewed native release');
 }
 if(changed!==1)throw new Error('A stage must change exactly one selected instance');
 // One SHA denotes one immutable dependency tree, never two runtime generations.
 const generations=new Map<string,string>();
 for(const entry of [...p.previous,...p.desired]){const prior=generations.get(entry.releaseSha);if(prior&&prior!==entry.runtime)throw new Error('One release cannot select incompatible runtime generations');generations.set(entry.releaseSha,entry.runtime);}
 return structuredClone(p);
}
/** This validates an operator's observation record, not remote effects. The
 * retained evidence digest must refer to independently inspected private proof.
 * Admission-only handoff files cannot stand in for a completed native run. */
export function assertCanaryObservation(plan:RuntimeActivation,value:unknown,now=Date.now()):asserts value is CanaryObservation {
 if(!object(value)||!keys(value,['version','stageId','instanceId','releaseSha','startedAt','initialReady','restartReady','scheduledWork','observedUntil','evidenceDigest'])||value.version!==1||value.stageId!==plan.stageId||value.instanceId!==plan.selectedInstance||value.releaseSha!==plan.desired.find(s=>s.instanceId===plan.selectedInstance)?.releaseSha||!digest(value.evidenceDigest))throw new Error('Canary observation identity does not match the selected stage');
 const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=now;
 const ready=(v:unknown):v is {at:number;pid:number}=>object(v)&&keys(v,['at','pid'])&&time(v.at)&&Number.isSafeInteger(v.pid)&&Number(v.pid)>0;
 if(!time(value.startedAt)||!time(value.observedUntil)||value.observedUntil-value.startedAt<plan.observationMs||!ready(value.initialReady)||!ready(value.restartReady)||
  value.initialReady.at<value.startedAt||value.observedUntil-value.initialReady.at<plan.observationMs||value.restartReady.at<=value.initialReady.at||value.restartReady.pid===value.initialReady.pid||value.restartReady.at>value.observedUntil||
  !object(value.scheduledWork)||!keys(value.scheduledWork,['at','dispatchId','submissionId','outcome'])||!time(value.scheduledWork.at)||value.scheduledWork.at<value.initialReady.at||value.scheduledWork.at>value.observedUntil||value.scheduledWork.outcome!=='done'||
  typeof value.scheduledWork.dispatchId!=='string'||!/^[a-z0-9-]{1,64}-[a-f0-9]{16}(?:[a-f0-9]{48})?$/.test(value.scheduledWork.dispatchId)||
  typeof value.scheduledWork.submissionId!=='string'||!value.scheduledWork.submissionId||value.scheduledWork.submissionId.length>256||/[\0\r\n]/.test(value.scheduledWork.submissionId))throw new Error('Canary observation requires exact readiness, a controlled restart, completed scheduled work and the full observation interval');
}
/** Cross-check retained root evidence against the active readiness receipt. */
export function assertCanaryEvidence(plan:RuntimeActivation,observation:CanaryObservation,evidence:unknown,ready:{startedAt:number;initialReady:{at:number;pid:number}}):void {
 assertCanaryObservation(plan,observation);
 const sameReady=(a:unknown,b:{at:number;pid:number})=>object(a)&&a.at===b.at&&a.pid===b.pid;
 if(observation.startedAt!==ready.startedAt||!sameReady(observation.initialReady,ready.initialReady)||!object(evidence)||evidence.version!==1||evidence.stageId!==plan.stageId||!sameReady(evidence.initialReady,observation.initialReady)||!sameReady(evidence.restartReady,observation.restartReady)||!object(evidence.proof))throw new Error('Retained canary evidence differs from active readiness');
 const proof=evidence.proof;
 if(proof.version!==1||proof.instanceId!==plan.selectedInstance||proof.dispatchId!==observation.scheduledWork.dispatchId||proof.submissionId!==observation.scheduledWork.submissionId||proof.outcome!=='done'||proof.inspectedAt!==observation.scheduledWork.at||!Number.isSafeInteger(proof.createdAt)||Number(proof.createdAt)<ready.initialReady.at||Number(proof.createdAt)>Number(proof.inspectedAt)||createHash('sha256').update(JSON.stringify(evidence)).digest('hex')!==observation.evidenceDigest)throw new Error('Retained canary proof differs from its observation');
}
/** Read-only immutable release preflight. It intentionally does not execute any
 * imported candidate code. System identity/configuration preflight stays with
 * the existing mixed-manager administrator adapter. */
export const brokerReleaseEntrypoints=['dist/src/trusted-broker-daemon.js','dist/src/recovery-start-check.js','dist/src/isolation-network-service.js','dist/src/isolation-proxy-service.js'] as const;
/** Every file a rendered unit executes for one runtime selection. System
 * (isolated) instances also run the isolation start check from their release. */
export function runtimeSelectionEntrypoints(entry:RuntimeSelection,isolated:boolean):string[] {
 return [entry.runtime==='legacy'?'dist/src/daemon.js':'dist/src/durable/daemon.js',
  ...(entry.runtime==='pi-durable'?['dist/src/durable/inspect.js']:[]),
  'dist/src/recovery-start-check.js',...(isolated?['dist/src/isolation-start-check.js']:[])];
}
/** `isolatedInstanceIds` names instances installed as isolated system units. */
export async function inspectSelectedReleases(plan:RuntimeActivation,options:{isolatedInstanceIds?:readonly string[]}={}) {
 const valid=parseRuntimeActivation(plan,plan.previous.map(s=>s.instanceId));
 if(await realpath(valid.releaseRoot)!==valid.releaseRoot)throw new Error('Release root must be canonical');
 const releases=new Map<string,Set<string>>();
 for(const entry of [...valid.previous,...valid.desired]){
  const entries=releases.get(entry.releaseSha)??new Set<string>();for(const file of runtimeSelectionEntrypoints(entry,options.isolatedInstanceIds?.includes(entry.instanceId)??false))entries.add(file);releases.set(entry.releaseSha,entries);
 }
 const broker=releases.get(valid.brokerReleaseSha)??new Set<string>();for(const file of brokerReleaseEntrypoints)broker.add(file);releases.set(valid.brokerReleaseSha,broker);
 const result:Array<{releaseSha:string;path:string;digest:string;entrypoints:string[]}>=[];
 for(const [releaseSha,entries] of [...releases].sort(([a],[b])=>a.localeCompare(b))){
  const root=join(valid.releaseRoot,releaseSha);
  if(await realpath(root)!==root)throw new Error('Immutable release path must be canonical');
  const info=await lstat(root);if(!info.isDirectory())throw new Error('Immutable release must be a directory');
  for(const entry of entries){
   try{const full=join(root,entry),meta=await lstat(full);if(!meta.isFile()||meta.nlink!==1||await realpath(full)!==full)throw new Error();}
   catch{throw new Error('Selected runtime entrypoint is missing or unsafe');}
  }
  result.push({releaseSha,path:root,digest:await digestTree(root,true,false,undefined,info.uid),entrypoints:[...entries].sort()});
 }
 return result;
}
/** Reuse the established hold/checkpoint/no-rewind sequence. No rollback callback
 * exists. The concrete adapter installs plan.desired and verifies every peer at
 * its own approved SHA. Advancement is a separate explicit invocation. */
export function assertRuntimeAdvancement(plan:RuntimeActivation,previous?:{plan:RuntimeActivation;observation?:unknown}):void {
 const valid=parseRuntimeActivation(plan,plan.previous.map(s=>s.instanceId));
 if(valid.previous.some(s=>s.runtime==='pi-durable')&&!previous)throw new Error('Advancement requires the previous canary observation');
 if(previous){
  const prior=parseRuntimeActivation(previous.plan,valid.previous.map(s=>s.instanceId));
  if(prior.stageId===valid.stageId||!sameRuntimeMap(prior.desired,valid.previous))throw new Error('Previous stage mapping does not match this stage');
  assertCanaryObservation(prior,previous.observation);
 }
}
export async function activateRuntimeStage(plan:RuntimeActivation,operations:IsolatedDeploymentOperations,previous?:{plan:RuntimeActivation;observation?:unknown},signal?:AbortSignal):Promise<void> {
 assertRuntimeAdvancement(plan,previous);
 await activateIsolatedDeployment(operations,signal);
}
