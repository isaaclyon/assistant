import {mkdtemp,readFile,rm,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {notifyVerifiedStage} from '../../src/durable/deployment-notification.js';
import type {RuntimeActivation,CanaryObservation} from '../../src/durable/activation.js';
function fixture(){
 const plan:RuntimeActivation={version:1,stageId:'a'.repeat(64),selectedInstance:'builder',releaseRoot:'/opt/releases',brokerReleaseSha:'b'.repeat(40),observationMs:100,previous:[{instanceId:'builder',runtime:'pi-durable',releaseSha:'c'.repeat(40),nativeConfigPath:'/private/old'}],desired:[{instanceId:'builder',runtime:'pi-durable',releaseSha:'d'.repeat(40),nativeConfigPath:'/private/new'}]};
 const initialReady={at:1000,pid:11},restartReady={at:1200,pid:12},ready={startedAt:900,initialReady};
 const proof={version:1,instanceId:'builder',dispatchId:'canary-'+'e'.repeat(64),submissionId:'20',outcome:'done',createdAt:1010,inspectedAt:1100};
 const evidence={version:1,stageId:plan.stageId,proof,initialReady,restartReady};
 const observation:CanaryObservation={version:1,stageId:plan.stageId,instanceId:'builder',releaseSha:'d'.repeat(40),startedAt:900,initialReady,restartReady,scheduledWork:{at:1100,dispatchId:proof.dispatchId,submissionId:'20',outcome:'done'},observedUntil:1300,evidenceDigest:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
 return {plan,ready,evidence,observation};
}
async function temporary(fn:(directory:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'deployment-notice-'));try{await fn(directory);}finally{await rm(directory,{recursive:true,force:true});}}
it('sends a scoped code-deployed confirmation after verified evidence and only once',()=>temporary(async directory=>{
 const send=vi.fn(async(_text:string)=>{}),args={...fixture(),directory,send};
 expect(await notifyVerifiedStage(args)).toEqual({status:'confirmed',attempted:true});
 expect(send).toHaveBeenCalledOnce();expect(send.mock.calls[0]?.[0]).toContain('✅ Code deployed: ddddddd — builder.');
 expect(send.mock.calls[0]?.[0]).not.toContain('All');
 expect(await notifyVerifiedStage(args)).toEqual({status:'confirmed',attempted:false});expect(send).toHaveBeenCalledOnce();
}));
it('refuses admission-only, mismatched or missing completion evidence before any notice',()=>temporary(async directory=>{
 const send=vi.fn(async()=>{}),f=fixture();
 await expect(notifyVerifiedStage({...f,directory,send,evidence:{...f.evidence,proof:{...f.evidence.proof,outcome:'admitted'}}})).rejects.toThrow();
 await expect(notifyVerifiedStage({...f,directory,send,observation:{...f.observation,instanceId:'personal'}})).rejects.toThrow();expect(send).not.toHaveBeenCalled();
}));
it('records intent before sending and never automatically repeats an unknown outcome',()=>temporary(async directory=>{
 const send=vi.fn(async()=>{expect(JSON.parse(await readFile(join(directory,'notification.json'),'utf8')).status).toBe('started');throw Error('provider data must stay private');});
 const args={...fixture(),directory,send};expect(await notifyVerifiedStage(args)).toEqual({status:'unknown',attempted:true});
 expect(await notifyVerifiedStage(args)).toEqual({status:'unknown',attempted:false});expect(send).toHaveBeenCalledOnce();
 expect(await readFile(join(directory,'notification.json'),'utf8')).not.toContain('provider data');
}));
it('a crash marker is an unknown send, not authorization to replay',()=>temporary(async directory=>{
 const f=fixture(),send=vi.fn(async()=>{});
 await writeFile(join(directory,'notification.json'),JSON.stringify({version:1,stageId:f.plan.stageId,instanceId:'builder',releaseSha:'d'.repeat(40),evidenceDigest:f.observation.evidenceDigest,status:'started',attemptedAt:1000}),{mode:0o600});
 expect(await notifyVerifiedStage({...f,directory,send})).toEqual({status:'unknown',attempted:false});expect(send).not.toHaveBeenCalled();
}));
it('does not follow a symlink or reuse a different stage receipt',()=>temporary(async directory=>{
 const send=vi.fn(async()=>{}),path=join(directory,'notification.json'),outside=join(directory,'other');
 await writeFile(outside,'{}',{mode:0o600});await symlink(outside,path);await expect(notifyVerifiedStage({...fixture(),directory,send})).rejects.toThrow();
 await rm(path);await writeFile(path,JSON.stringify({stageId:'other'}),{mode:0o600});await expect(notifyVerifiedStage({...fixture(),directory,send})).rejects.toThrow();expect(send).not.toHaveBeenCalled();
}));
it('serializes concurrent callers rather than duplicating the external notice',()=>temporary(async directory=>{
 const send=vi.fn(async()=>{await new Promise(r=>setTimeout(r,20));});const args={...fixture(),directory,send};
 const results=await Promise.all([notifyVerifiedStage(args),notifyVerifiedStage(args)]);expect(send).toHaveBeenCalledOnce();expect(results.filter(r=>r.attempted)).toHaveLength(1);
}));
