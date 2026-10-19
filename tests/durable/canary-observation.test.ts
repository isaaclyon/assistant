import { mkdtemp, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseCanaryCompletionProof, parseCanaryDispatchSelection, readCanaryRecoveryAuthorization } from '../../src/durable/activation.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const dispatchId=`synthetic-${'e'.repeat(64)}`;
const proof=()=>({version:1,instanceId:'personal',dispatchId,submissionId:19,outcome:'done',createdAt:1100,inspectedAt:1200});
const expected={instanceId:'personal',dispatchId,initialReadyAt:1000};
it('accepts the numeric SDK submission identity and retains a canonical string in administrator evidence',()=>{
 expect(parseCanaryCompletionProof(proof(),expected,1300)).toEqual({...proof(),submissionId:'19'});
 expect(parseCanaryCompletionProof({...proof(),submissionId:'s-1'},expected,1300).submissionId).toBe('s-1');
 for(const submissionId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,null,'','bad\nidentity','x'.repeat(257)])expect(()=>parseCanaryCompletionProof({...proof(),submissionId},expected,1300)).toThrow();
});
it('rejects admission-only, different-stage and different-dispatch completion proof',()=>{
 for(const change of [{version:2},{instanceId:'builder'},{dispatchId:`other-${'e'.repeat(64)}`},{outcome:'admitted'},{createdAt:999},{createdAt:1201},{inspectedAt:1301},{inspectedAt:999}]){
  expect(()=>parseCanaryCompletionProof({...proof(),...change},expected,1300)).toThrow();
 }
});
it('requires an explicit administrator selection to resume a retained hold',()=>{
 expect(parseCanaryDispatchSelection({dispatchId})).toEqual({dispatchId});
 expect(parseCanaryDispatchSelection({dispatchId,resumeHeld:true})).toEqual({dispatchId,resumeHeld:true});
 for(const selection of [{dispatchId,resumeHeld:false},{dispatchId,resumeHeld:'true'},{dispatchId,other:true},{dispatchId:'bad'},null])expect(()=>parseCanaryDispatchSelection(selection)).toThrow();
});
it('reads only a private owned hold matching the retained active checkpoint',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canary-hold-'));roots.push(root);const marker=join(root,'hold'),authorization='12345678-1234-1234-1234-123456789abc',snapshotDir='/private/synthetic-checkpoint';
 const save=async(value:unknown)=>writeFile(marker,JSON.stringify(value),{mode:0o600});
 await save({version:1,authorization,snapshotDir});
 expect(await readCanaryRecoveryAuthorization(marker,process.getuid!(),snapshotDir)).toBe(authorization);
 await expect(readCanaryRecoveryAuthorization(marker,process.getuid!(),'/different')).rejects.toThrow();
 await expect(readCanaryRecoveryAuthorization(marker,process.getuid!()+1,snapshotDir)).rejects.toThrow();
 await chmod(marker,0o644);await expect(readCanaryRecoveryAuthorization(marker,process.getuid!(),snapshotDir)).rejects.toThrow();await chmod(marker,0o600);
 for(const change of [{version:2},{authorization:'bad'},{snapshotDir:'/different'},{unreviewed:true}]){await save({version:1,authorization,snapshotDir,...change});await expect(readCanaryRecoveryAuthorization(marker,process.getuid!(),snapshotDir)).rejects.toThrow();}
 const link=join(root,'link');await symlink(marker,link);await expect(readCanaryRecoveryAuthorization(link,process.getuid!(),snapshotDir)).rejects.toThrow();
});
