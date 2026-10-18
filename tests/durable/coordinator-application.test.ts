import { mkdir,readFile,readdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach,expect,test,vi } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { startJobScheduler,jobsContentHash,type JobScheduler } from '../../src/jobs.js';
import { enqueueJobHandoff,cancelJobHandoff,drainJobHandoffs } from '../../src/job-handoff.js';
import { loadNativeConfig } from '../../src/durable/config.js';
import { cleanup,setup } from './parity-application-fixture.js';
const now=()=>Date.parse('2024-01-02T03:04:05.000Z');
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

for(const coordinator of ['legacy','native'] as const)for(const recipient of ['legacy','native'] as const){
 test(`${coordinator} coordinator publishes once to a ${recipient} recipient through the v1 exchange`,async()=>{
  const s=await setup(coordinator==='native'?'durable-jobs-coordinator-test':'durable-jobs-test');
  const coordinatorStateDir=join(s.directory,'coordinator');await mkdir(coordinatorStateDir,{recursive:true,mode:0o700});
  const target=recipient==='native'?'test':'legacy-peer',recipientState=join(s.directory,'instances',target);
  await mkdir(recipientState,{recursive:true,mode:0o700});
  if(s.config.coordinator&&recipient==='legacy'){s.config.coordinator.scope='shared-owner';s.config.coordinator.targets=[target];}
  await writeFile(join(coordinatorStateDir,'jobs.json'),JSON.stringify({version:3,jobs:[{id:'late-reminder',type:'at',at:'2024-01-01T00:00:00.000Z',target,prompt:'Synthetic late reminder'}]}),{mode:0o600});
  await s.open(recipient==='native'?[fauxAssistantMessage('SCHEDULED')]:[],false,{coordinator:{nowMs:now,tickIntervalMs:20}});
  let legacy:JobScheduler|undefined;
  if(coordinator==='legacy'){
   legacy=await startJobScheduler({stateDir:coordinatorStateDir,webhookHost:'127.0.0.1',webhookPort:0,logger:{info:()=>{},warn:()=>{},error:()=>{}},validTargets:new Set([target]),requireTargets:true,nowMs:now,tickIntervalMs:60_000,cancel:async d=>{await cancelJobHandoff({stateRoot:s.directory,coordinatorStateDir,dispatchId:d.occurrenceId!,jobId:d.jobId,target:d.target!});},
    inject:async(prompt,dispatch)=>{if(!dispatch?.definitionFingerprint)throw new Error('Missing occurrence');await enqueueJobHandoff({stateRoot:s.directory,coordinatorStateDir,eventId:dispatch.eventId,definitionFingerprint:dispatch.definitionFingerprint,jobId:dispatch.jobId,jobType:dispatch.jobType,target:dispatch.target!,prompt,now:()=>new Date(now())});}});
   cleanup.push(()=>legacy!.stop());await legacy.tick();
  }
  let accepted=0;
  if(recipient==='legacy'){
   await vi.waitFor(async()=>expect((await readdir(join(recipientState,'job-handoffs','pending'))).filter(n=>n.endsWith('.json'))).toHaveLength(1));
   expect(await drainJobHandoffs({stateDir:recipientState,instanceId:target,inject:async(prompt,_type,preflight)=>{expect(prompt).toContain('Synthetic late reminder');accepted++;preflight(true);await new Promise(()=>{});}})).toMatchObject({processed:1,uncertain:0});
  }else{
   await vi.waitFor(async()=>{await s.app()!.host.reconcile();expect(s.finals).toEqual(['SCHEDULED']);});
   expect(s.previews).toEqual([]);
  }
  const completed=await readdir(join(recipientState,'job-handoffs','completed'));expect(completed).toHaveLength(1);
  const first=JSON.parse(await readFile(join(recipientState,'job-handoffs','completed',completed[0]!),'utf8'));
  expect(first.createdAt).toBe(new Date(now()).toISOString());expect(first.target).toBe(target);
  if(legacy){await legacy.tick();await legacy.stop();legacy=undefined;cleanup.pop();}
  await s.close();
  await s.open([fauxAssistantMessage('SHOULD NOT RUN')],false,{coordinator:{nowMs:now,tickIntervalMs:20}});
  if(coordinator==='legacy'){
   legacy=await startJobScheduler({stateDir:coordinatorStateDir,webhookHost:'127.0.0.1',webhookPort:0,logger:{info:()=>{},warn:()=>{},error:()=>{}},validTargets:new Set([target]),requireTargets:true,nowMs:now,tickIntervalMs:60_000,cancel:async d=>{await cancelJobHandoff({stateRoot:s.directory,coordinatorStateDir,dispatchId:d.occurrenceId!,jobId:d.jobId,target:d.target!});},inject:async()=>{throw new Error('Published one-shot must not repeat');}});
   cleanup.push(()=>legacy!.stop());await legacy.tick();
  }
  await s.app()!.host.reconcile();
  expect(await readdir(join(recipientState,'job-handoffs','completed'))).toEqual(completed);
  expect(await readdir(join(recipientState,'job-handoffs','pending'))).toEqual([]);
  if(recipient==='legacy'){expect(accepted).toBe(1);expect(s.requests).toHaveLength(0);}
  else{expect(s.finals).toEqual(['SCHEDULED']);expect(s.requests).toHaveLength(1);}
  if(coordinator==='native')expect(await s.app()!.inspectJobs()).toMatchObject({coordinator:{running:true,occurrences:{pending:0,published:1,superseded:0}}});
  const removed=JSON.stringify({version:3,jobs:[]});
  await writeFile(join(coordinatorStateDir,'jobs.json'),removed,{mode:0o600});
  if(legacy)await legacy.reload();
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(coordinatorStateDir,'jobs-state.json'),'utf8')).acceptedHash).toBe(jobsContentHash(removed)));
  expect(await readdir(join(recipientState,'job-handoffs','completed'))).toEqual(completed);
  expect(await readdir(join(recipientState,'job-handoffs','cancelled')).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;})).toEqual([]);
  expect(s.fatal).toEqual([]);
 });
}

test('coordinator selection is explicit and read-only inspection never initializes scheduling',async()=>{
 const s=await setup('durable-jobs-coordinator-test');
 const {historyDir,inboxPath,runtimeMetadataPath,...raw}=s.config;
 const path=join(s.directory,'instance.json');await writeFile(path,JSON.stringify(raw),{mode:0o600});
 await expect(loadNativeConfig(path)).resolves.toMatchObject({jobsRole:'coordinator',coordinator:{scope:'self',targets:['test']}});
 await mkdir(join(raw.stateDir,'coordinator'),{mode:0o700});
 for(const changed of [{jobsRole:'recipient'},{coordinator:{...raw.coordinator,targets:['peer']}},{coordinator:{...raw.coordinator,scope:'shared-owner',targets:['peer','peer']}},{coordinator:{...raw.coordinator,coordinatorStateDir:join(raw.stateDir,'coordinator')}},{capabilityProfile:'durable-jobs-test'}]){
  await writeFile(path,JSON.stringify({...raw,...changed}),{mode:0o600});await expect(loadNativeConfig(path)).rejects.toThrow();
 }
 await s.open([],false,{},undefined,async app=>{
  expect(await app.inspectJobs()).toMatchObject({coordinator:{running:false,occurrences:undefined}});
  expect(await readdir(s.config.coordinator!.coordinatorStateDir)).toEqual([]);
 });
 expect(s.requests).toEqual([]);expect(s.fatal).toEqual([]);
});
