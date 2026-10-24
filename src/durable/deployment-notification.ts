import {constants} from 'node:fs';
import {lstat,open,realpath,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withMutationLock} from '../../.pi/lib/mutation-lock.mjs';
import {writeDurableExclusive} from '../isolated-recovery.js';
import {assertCanaryEvidence,parseRuntimeActivation,type RuntimeActivation,type CanaryObservation} from './activation.js';

export interface StageNotificationOptions {
 plan:RuntimeActivation;observation:CanaryObservation;evidence:unknown;
 ready:{startedAt:number;initialReady:{at:number;pid:number}};
 /** Private administrator-owned stage directory. The caller retains current-map,
  * installed-release and live readiness checks; this verifies retained evidence. */
 directory:string;
 /** Destination is selected from the administrator's engineering runtime, never
  * from a job, remote document, observation file, or caller-supplied chat ID. */
 send:(text:string)=>Promise<void>;
}
export interface StageNotificationResult {status:'confirmed'|'unknown';attempted:boolean}
/** Notification failure never changes runtime recovery state. An unfinished send
 * receipt is an unknown external effect, not permission to send it again. */
export async function notifyVerifiedStage(options:StageNotificationOptions):Promise<StageNotificationResult>{
 const plan=parseRuntimeActivation(options.plan,options.plan.previous.map(entry=>entry.instanceId));
 assertCanaryEvidence(plan,options.observation,options.evidence,options.ready);
 const info=await lstat(options.directory);
 if(!info.isDirectory()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||await realpath(options.directory)!==options.directory)throw new Error('Unsafe notification receipt directory');
 const path=join(options.directory,'notification.json');
 return withMutationLock(join(options.directory,'notification-lock.sqlite'),async()=>{
  const identity={version:1,stageId:plan.stageId,instanceId:plan.selectedInstance,releaseSha:options.observation.releaseSha,evidenceDigest:options.observation.evidenceDigest};
  try{
   const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const meta=await f.stat();if(!meta.isFile()||meta.nlink!==1||meta.uid!==process.getuid?.()||(meta.mode&0o777)!==0o600||meta.size>4096)throw new Error('Unsafe notification receipt');
    const saved=JSON.parse(await f.readFile('utf8'));
    if(Object.entries(identity).some(([key,value])=>saved[key]!==value)||!['started','confirmed','unknown'].includes(saved.status)||!Number.isSafeInteger(saved.attemptedAt)||saved.attemptedAt<0)throw new Error('Notification receipt does not match the verified stage');
    return {status:saved.status==='confirmed'?'confirmed':'unknown',attempted:false};
   }finally{await f.close();}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const receipt={...identity,status:'started',attemptedAt:Date.now()};
  await writeDurableExclusive(path,receipt);
  let status:'confirmed'|'unknown'='unknown';
  try{
   await options.send(`✅ Code deployed: ${identity.releaseSha.slice(0,7)} — ${identity.instanceId}.\nVerified: scheduled canary completed and restart/readiness checks passed.`);
   status='confirmed';
  }catch{/* Never retain or print credentials, provider payloads, or raw errors. */}
  const temporary=path+'.'+randomUUID()+'.tmp';
  await writeDurableExclusive(temporary,{...receipt,status,finishedAt:Date.now()});await rename(temporary,path);
  const directory=await open(options.directory,'r');try{await directory.sync();}finally{await directory.close();}
  return {status,attempted:true};
 });
}
