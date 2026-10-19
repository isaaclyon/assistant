import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { parseRuntimeActivation, activateRuntimeStage, assertCanaryObservation, assertCanaryEvidence, inspectSelectedReleases, type RuntimeActivation } from '../../src/durable/activation.js';
import type { IsolatedDeploymentOperations } from '../../src/isolated-deployment.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const old='a'.repeat(40),next='b'.repeat(40),broker='c'.repeat(40),stageId='d'.repeat(64);
const plan=():RuntimeActivation=>({version:1,stageId,selectedInstance:'personal',releaseRoot:'/opt/bridge/releases',brokerReleaseSha:broker,observationMs:1000,previous:[{instanceId:'personal',runtime:'legacy',releaseSha:old},{instanceId:'builder',runtime:'legacy',releaseSha:old}],desired:[{instanceId:'personal',runtime:'pi-durable',releaseSha:next,nativeConfigPath:'/etc/bridge/personal.json'},{instanceId:'builder',runtime:'legacy',releaseSha:old}]});
it('selects exactly one transition and preserves each peer and the independent broker release',()=>{
 const result=parseRuntimeActivation(plan(),['personal','builder']);expect(result.desired[1]).toEqual(result.previous[1]);expect(result.brokerReleaseSha).toBe(broker);
 for(const mutation of [
  (p:RuntimeActivation)=>{p.desired[1]!.releaseSha=next;},
  (p:RuntimeActivation)=>{p.desired[0]!.runtime='legacy';},
  (p:RuntimeActivation)=>{p.desired[0]!.releaseSha=old;},
  (p:RuntimeActivation)=>{p.desired.push({...p.desired[0]!});},
  (p:RuntimeActivation)=>{p.previous.pop();},
  (p:RuntimeActivation)=>{p.desired[0]!.nativeConfigPath='/etc/../tmp/config';},
  (p:RuntimeActivation)=>{p.desired[0]!.nativeConfigPath='/etc/%n';},
  (p:RuntimeActivation)=>{p.desired[1]!.nativeConfigPath='/etc/bridge/unselected.json';},
 ]){const value=plan();mutation(value);expect(()=>parseRuntimeActivation(value,['personal','builder'])).toThrow();}
 expect(()=>parseRuntimeActivation({...plan(),unreviewed:true},['personal','builder'])).toThrow();
});
it('requires an observed canary at the exact stage, release and instance before deliberate advancement',()=>{
 const p=plan();const observation={version:1 as const,stageId,instanceId:'personal',releaseSha:next,startedAt:1000,initialReady:{at:1100,pid:100},restartReady:{at:1800,pid:101},scheduledWork:{at:1900,dispatchId:`reminder-${'e'.repeat(16)}`,submissionId:'s-1',outcome:'done' as const},observedUntil:2100,evidenceDigest:'f'.repeat(64)};
 expect(()=>assertCanaryObservation(p,observation,2200)).not.toThrow();
 for(const change of [{instanceId:'builder'},{releaseSha:old},{stageId:'0'.repeat(64)},{observedUntil:1900},{restartReady:{at:1800,pid:100}},{scheduledWork:{...observation.scheduledWork,outcome:'admitted'}},{scheduledWork:{...observation.scheduledWork,at:900}},{initialReady:{at:2300,pid:100}},{evidenceDigest:''}])expect(()=>assertCanaryObservation(p,{...observation,...change},2200)).toThrow();
});
it('cross-checks root evidence against active readiness and the exact completed proof',()=>{
 const p=plan(),at=Date.now()-10_000;
 const ready={startedAt:at,initialReady:{at:at+100,pid:100}};
 const proof={version:1,instanceId:'personal',dispatchId:`reminder-${'e'.repeat(16)}`,submissionId:'s-1',outcome:'done',createdAt:at+200,inspectedAt:at+1900};
 const evidence={version:1,stageId,proof,initialReady:ready.initialReady,restartReady:{at:at+1800,pid:101}};
 const observation={version:1 as const,stageId,instanceId:'personal',releaseSha:next,...ready,restartReady:evidence.restartReady,scheduledWork:{at:proof.inspectedAt,dispatchId:proof.dispatchId,submissionId:proof.submissionId,outcome:'done' as const},observedUntil:at+2100,evidenceDigest:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
 expect(()=>assertCanaryEvidence(p,observation,evidence,ready)).not.toThrow();
 for(const change of [{stageId:'f'.repeat(64)},{initialReady:{...ready.initialReady,pid:999}},{proof:{...proof,instanceId:'builder'}},{proof:{...proof,createdAt:at}},{proof:{...proof,submissionId:'another'}}]){
  const altered={...evidence,...change};
  const matchingDigest={...observation,evidenceDigest:createHash('sha256').update(JSON.stringify(altered)).digest('hex')};
  expect(()=>assertCanaryEvidence(p,matchingDigest,altered,ready)).toThrow();
 }
 expect(()=>assertCanaryEvidence(p,observation,evidence,{...ready,initialReady:{...ready.initialReady,pid:999}})).toThrow();
});
function operations(events:string[],fail?:string):IsolatedDeploymentOperations {
 const names=['preflight','hold','stopAll','assertQuiescent','checkpoint','migrate','install','markStarted','authorize','start','ready','revoke','enable','complete'] as const;
 return Object.fromEntries(names.map(name=>[name,async()=>{events.push(name);if(name===fail)throw new Error('synthetic failure');}])) as unknown as IsolatedDeploymentOperations;
}
it('uses coordinated maintenance, checkpoint and irreversible startup barrier before the selected runtime starts',async()=>{
 const events:string[]=[];await activateRuntimeStage(plan(),operations(events),undefined);
 expect(events).toEqual(['preflight','hold','stopAll','assertQuiescent','checkpoint','migrate','install','markStarted','authorize','start','ready','revoke','enable','complete']);
});
it.each(['install','start','ready','complete'])('holds every writer after %s failure and never rolls back state or binaries',async phase=>{
 const events:string[]=[];await expect(activateRuntimeStage(plan(),operations(events,phase))).rejects.toThrow('Deployment held');
 expect(events.slice(-3)).toEqual(['revoke','stopAll','assertQuiescent']);expect(events).not.toContain('rollback');
});
it('requires the previous observed stage before another instance can advance',async()=>{
 const current=plan(),second=plan();second.stageId='e'.repeat(64);second.selectedInstance='builder';second.previous=structuredClone(current.desired);second.desired=structuredClone(current.desired);second.desired[1]={instanceId:'builder',runtime:'pi-durable',releaseSha:'f'.repeat(40),nativeConfigPath:'/etc/bridge/builder.json'};
 const events:string[]=[];
 await expect(activateRuntimeStage(second,operations(events),{plan:current})).rejects.toThrow(/observation/i);expect(events).toEqual([]);
 const observation={version:1,stageId,instanceId:'personal',releaseSha:next,startedAt:1000,initialReady:{at:1100,pid:100},restartReady:{at:1800,pid:101},scheduledWork:{at:1900,dispatchId:`reminder-${'e'.repeat(16)}`,submissionId:'s-1',outcome:'done'},observedUntil:2100,evidenceDigest:'f'.repeat(64)};
 await activateRuntimeStage(second,operations(events),{plan:current,observation});expect(events.at(-1)).toBe('complete');
 const third=structuredClone(second);third.previous[0]!.nativeConfigPath='/etc/bridge/wrong-config.json';third.desired[0]!.nativeConfigPath='/etc/bridge/wrong-config.json';
 await expect(activateRuntimeStage(third,operations([]),{plan:current,observation})).rejects.toThrow(/mapping/);
});
it('verifies every selected immutable entrypoint and reports digests without importing a release',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-activation-')));roots.push(root);const releaseRoot=join(root,'releases');
 const p=plan();p.releaseRoot=releaseRoot;
 const files:Record<string,string[]>={[old]:['daemon','recovery-start-check','isolation-start-check'],[next]:['durable/daemon','durable/inspect','recovery-start-check','isolation-start-check'],[broker]:['trusted-broker-daemon','recovery-start-check','isolation-network-service','isolation-proxy-service']};
 for(const [sha,entries] of Object.entries(files))for(const entry of entries){const path=join(releaseRoot,sha,'dist/src',entry+'.js');await mkdir(join(path,'..'),{recursive:true,mode:0o700});await writeFile(path,'throw new Error("must never import during preflight");',{mode:0o600});}
 const isolated={isolatedInstanceIds:['personal']};const selected=await inspectSelectedReleases(p,isolated);expect(selected).toHaveLength(3);expect(selected.every(r=>/^[a-f0-9]{64}$/.test(r.digest))).toBe(true);
 for(const [sha,file,options] of [[next,'durable/daemon',{}],[next,'durable/inspect',{}],[next,'recovery-start-check',{}],[old,'recovery-start-check',{}],[old,'isolation-start-check',isolated],[next,'isolation-start-check',isolated],[broker,'trusted-broker-daemon',{}],[broker,'recovery-start-check',{}],[broker,'isolation-network-service',{}],[broker,'isolation-proxy-service',{}]] as const){
  const path=join(releaseRoot,sha,'dist/src',file+'.js'),content=await readFile(path);await rm(path);
  await expect(inspectSelectedReleases(p,options)).rejects.toThrow(/entrypoint/i);await writeFile(path,content,{mode:0o600});
 }
 // The isolation start check is required only for the isolated system unit.
 for(const sha of [old,next])await rm(join(releaseRoot,sha,'dist/src/isolation-start-check.js'));await expect(inspectSelectedReleases(p)).resolves.toHaveLength(3);
 expect(await readFile(join(releaseRoot,old,'dist/src/daemon.js'),'utf8')).toContain('must never import');
});
