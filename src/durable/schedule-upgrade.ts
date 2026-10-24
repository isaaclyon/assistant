import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export interface ScheduleUpgradeFrom { configPath:string; sha256:string }
export function parseScheduleUpgradeFrom(value:unknown):ScheduleUpgradeFrom {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid schedule upgrade predecessor');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join()!=='configPath,sha256'||typeof v.configPath!=='string'||!isAbsolute(v.configPath)||typeof v.sha256!=='string'||! /^[a-f0-9]{64}$/.test(v.sha256))throw new Error('Invalid schedule upgrade predecessor');
 return v as unknown as ScheduleUpgradeFrom;
}
export async function readSchedulePredecessor(ref:ScheduleUpgradeFrom,uid:number):Promise<Record<string,unknown>> {
 if(await realpath(ref.configPath)!==resolve(ref.configPath))throw new Error('Schedule predecessor must be canonical');
 const f=await open(ref.configPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await f.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==uid||(stat.mode&0o777)!==0o600||stat.size>128_000)throw new Error('Unsafe schedule predecessor');
  const bytes=await f.readFile();
  if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw new Error('Schedule predecessor digest differs');
  const value:unknown=JSON.parse(bytes.toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid schedule predecessor');
  return value as Record<string,unknown>;
 }finally{await f.close();}
}
/** Permit only the delegated schedule-management authority change. No arbitrary
 * replacement signature, recipient expansion, provider or transport change. */
export function assertScheduleOnlyUpgrade(current:Record<string,unknown>,previous:Record<string,unknown>):void {
 const withoutManagement=(input:Record<string,unknown>)=>{
  const result=Object.fromEntries(Object.entries(input).filter(([key])=>!['releaseSha','resourceRoot','instructionUpgradeFrom','scheduleUpgradeFrom','scheduleClient'].includes(key)));
  if(result.coordinator&&typeof result.coordinator==='object'&&!Array.isArray(result.coordinator)){
   const {control:_control,...coordinator}=result.coordinator as Record<string,unknown>;result.coordinator=coordinator;
  }
  return result;
 };
 if(!isDeepStrictEqual(withoutManagement(current),withoutManagement(previous)))throw new Error('Schedule upgrade cannot change other runtime authority');
 const management=(input:Record<string,unknown>)=>({client:input.scheduleClient,control:(input.coordinator as Record<string,unknown>|undefined)?.control});
 if(isDeepStrictEqual(management(current),management(previous)))throw new Error('Schedule upgrade requires a management authority change');
 if(current.releaseSha===previous.releaseSha)throw new Error('Schedule upgrade requires a distinct reviewed release');
 if(typeof current.resourceRoot!=='string'||typeof previous.resourceRoot!=='string'||basename(current.resourceRoot)!==current.releaseSha||basename(previous.resourceRoot)!==previous.releaseSha||dirname(current.resourceRoot)!==dirname(previous.resourceRoot))throw new Error('Schedule upgrade requires retained sibling SHA-named releases');
}
