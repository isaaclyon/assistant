import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { startJobScheduler, type JobDispatch } from '../../src/jobs.js';
import { startNativeJobsCoordinator } from '../../src/durable/coordinator.js';
import { enqueueJobHandoff, cancelJobHandoff, drainJobHandoffs } from '../../src/job-handoff.js';
import { cleanup, setup } from './parity-application-fixture.js';

const START=Date.parse('2024-01-02T03:04:05Z');
const logger={info(){},warn(){},error(){}};
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});

for(const kind of ['heartbeat','webhook'] as const)
for(const coordinator of ['legacy','native'] as const)
for(const recipient of ['legacy','native'] as const){
 test(`${kind}: ${coordinator} coordinator to ${recipient} recipient retains admission across restart and removal`,async()=>{
  const s=await setup('durable-jobs-test');
  const target=recipient==='native'?'test':'legacy-peer';
  const recipientState=join(s.directory,'instances',target);
  const coordinatorStateDir=join(s.directory,'coordinator');
  await mkdir(recipientState,{recursive:true,mode:0o700});await mkdir(coordinatorStateDir,{mode:0o700});
  const job=kind==='webhook'?{id:'trigger',type:kind,target,prompt:'Synthetic scheduled review'}:{
   id:'trigger',type:kind,target,schedule:'0 * * * *',tz:'UTC',checker:{id:'gmail-inbox',mode:'incremental',args:{account:'synthetic@example.test',timeZone:'UTC'}},
   rule:{type:'semantic-match',question:'Does {item} need action?',criteria:{true:'Action needed',false:'No action'},notifyAt:0.5},
   onTrigger:{type:'prompt',prompt:'Synthetic scheduled review'}};
  await writeFile(join(coordinatorStateDir,'jobs.json'),JSON.stringify({version:3,jobs:[job]}),{mode:0o600});
  let now=START,reads=0;
  const runCheck=vi.fn(async()=>({ok:true,stdout:JSON.stringify({version:2,value:{items:reads++===0?[]:[{id:'new-message',subject:'Synthetic'}]},cursor:{since:reads}})}));
  const judge=async()=>({model:'synthetic',probabilities:{item_0:0.9}});
  const start=async()=>{
   if(coordinator==='native')return startNativeJobsCoordinator({instanceId:'test',stateDir:s.config.stateDir,google:s.config.google!,coordinator:{stateRoot:s.directory,coordinatorStateDir,targets:[target],scope:target==='test'?'self':'shared-owner',schedules:{checkerIds:['gmail-inbox'],webhook:{port:12345}}}},{logger,nowMs:()=>now,tickIntervalMs:60_000,schedules:{runCheck,judge,webhookPort:0}});
   return startJobScheduler({stateDir:coordinatorStateDir,webhookHost:'127.0.0.1',webhookPort:0,logger,nowMs:()=>now,tickIntervalMs:60_000,validTargets:new Set([target]),requireTargets:true,runCheck,judge,
    inject:async(prompt:string,dispatch?:JobDispatch)=>{if(!dispatch?.definitionFingerprint)throw new Error('Missing occurrence');await enqueueJobHandoff({stateRoot:s.directory,coordinatorStateDir,eventId:dispatch.eventId,definitionFingerprint:dispatch.definitionFingerprint,jobId:dispatch.jobId,jobType:dispatch.jobType,target:dispatch.target!,prompt,now:()=>new Date(now)});},
    cancel:async d=>{await cancelJobHandoff({stateRoot:s.directory,coordinatorStateDir,dispatchId:d.occurrenceId!,jobId:d.jobId,target:d.target!});}});
  };
  await s.open(recipient==='native'?[fauxAssistantMessage('SCHEDULED')]:[],false);
  let scheduler=await start();cleanup.push(()=>scheduler.stop());
  if(kind==='heartbeat'){
   now+=3_600_000;await scheduler.tick();expect(reads).toBe(1);
   expect(await readdir(join(recipientState,'job-handoffs/pending')).catch(()=>[])).toEqual([]);
   now+=3_600_000;await scheduler.tick();expect(reads).toBe(2);
  }else{
   const secret=(await readFile(join(coordinatorStateDir,'webhook-secret'),'utf8')).trim();
   const response=await fetch(`http://127.0.0.1:${scheduler.webhookPort()}/hook/trigger`,{method:'POST',headers:{authorization:`Bearer ${secret}`},body:JSON.stringify({synthetic:true}),signal:AbortSignal.timeout(5_000)});
   expect(response.status).toBe(202);await scheduler.tick();
  }
  let accepted=0;
  if(recipient==='legacy'){
   await vi.waitFor(async()=>expect(await readdir(join(recipientState,'job-handoffs/pending'))).toHaveLength(1));
   expect(await drainJobHandoffs({stateDir:recipientState,instanceId:target,inject:async(prompt,_type,preflight)=>{expect(prompt).toContain('Synthetic scheduled review');accepted++;preflight(true);await new Promise(()=>{});}})).toMatchObject({processed:1,uncertain:0});
  }else await vi.waitFor(async()=>{await s.app()!.host.reconcile();expect(s.finals).toEqual(['SCHEDULED']);});
  const completed=await readdir(join(recipientState,'job-handoffs/completed'));expect(completed).toHaveLength(1);
  const original=await readFile(join(recipientState,'job-handoffs/completed',completed[0]!),'utf8');
  expect(JSON.parse(original)).toMatchObject({createdAt:new Date(now).toISOString(),jobType:kind,target});
  const readCount=reads;await scheduler.stop();await s.close();
  await s.open([fauxAssistantMessage('MUST NOT RUN')],false);scheduler=await start();await scheduler.tick();await s.app()!.host.reconcile();
  expect(reads).toBe(readCount);expect(await readdir(join(recipientState,'job-handoffs/completed'))).toEqual(completed);
  expect(await readdir(join(recipientState,'job-handoffs/pending'))).toEqual([]);
  await writeFile(join(coordinatorStateDir,'jobs.json'),JSON.stringify({version:3,jobs:[]}),{mode:0o600});await scheduler.reload();
  expect(await readFile(join(recipientState,'job-handoffs/completed',completed[0]!),'utf8')).toBe(original);
  expect(await readdir(join(recipientState,'job-handoffs/cancelled')).catch(()=>[])).toEqual([]);
  if(recipient==='native'){expect(s.finals).toEqual(['SCHEDULED']);expect(s.requests).toHaveLength(1);}else{expect(accepted).toBe(1);expect(s.requests).toHaveLength(0);}
  expect(s.fatal).toEqual([]);
 },20_000);
}
