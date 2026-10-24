import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { forwardScheduleRequest, readScheduleKey } from '../../src/schedule-control-client.js';
import { parseScheduleControl, startScheduleControl } from '../../src/schedule-control-server.js';
import { startNativeJobsCoordinator } from '../../src/durable/coordinator.js';
import { applyJobsRequest } from '../../src/jobs-cli.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const job=(id='ops-health',target='personal')=>({id,target,type:'cron',schedule:'*/5 * * * *',tz:'UTC',prompt:'Read-only health review.'});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'schedule-control-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
 const scope={jobPrefix:'ops-',targets:['personal']};
 const options={stateDir:dir,env:{},validateReload:false,scope};
 return {dir,options};
}
test('delegated writes require exact revision and filter private jobs without pruning them',async()=>{
 const s=await setup();const hidden={id:'private-reminder',target:'personal',type:'at',at:'2020-01-01T00:00:00Z',prompt:'PRIVATE_PROMPT'};
 await writeFile(join(s.dir,'jobs.json'),JSON.stringify({version:3,jobs:[hidden]}));
 await writeFile(join(s.dir,'jobs-state.json'),JSON.stringify({fired:{'private-reminder':123}}));
 const created=await applyJobsRequest({operation:'upsert',job:job(),expectedRevision:null},s.options);
 expect(created.publication).toMatchObject({status:'pending'});
 expect(created).not.toHaveProperty('stateDir');expect(created).not.toHaveProperty('pruned');
 const listed=await applyJobsRequest({operation:'list'},s.options);
 expect(JSON.stringify(listed)).not.toContain('PRIVATE_PROMPT');
 const inspected=await applyJobsRequest({operation:'inspect',id:'ops-health'},s.options);
 expect(inspected.revision).toMatch(/^[a-f0-9]{64}$/);
 await expect(applyJobsRequest({operation:'upsert',job:job()},s.options)).rejects.toThrow(/revision/i);
 await expect(applyJobsRequest({operation:'upsert',job:job(),expectedRevision:null},s.options)).rejects.toThrow(/revision/i);
 await expect(applyJobsRequest({operation:'remove',id:'ops-health',expectedRevision:'0'.repeat(64)},s.options)).rejects.toThrow(/revision/i);
 await applyJobsRequest({operation:'remove',id:'ops-health',expectedRevision:inspected.revision},s.options);
 expect(JSON.parse(await readFile(join(s.dir,'jobs.json'),'utf8')).jobs).toEqual([hidden]);
});
test('delegated scope rejects target escalation, prefix escape, hidden existing targets and privileged job types',async()=>{
 const s=await setup();
 for(const candidate of [job('other-health'),job('ops-health','builder'),{...job(),type:'webhook',hmacSecret:'SECRET'},{...job(),type:'heartbeat'}]){
  await expect(applyJobsRequest({operation:'upsert',job:candidate,expectedRevision:null},s.options)).rejects.toThrow();
 }
 await writeFile(join(s.dir,'jobs.json'),JSON.stringify({version:3,jobs:[job('ops-health','builder')]}));
 await expect(applyJobsRequest({operation:'upsert',job:job(),expectedRevision:null},s.options)).rejects.toThrow();
 await expect(applyJobsRequest({operation:'inspect',id:'ops-health'},s.options)).rejects.toThrow();
 await expect(applyJobsRequest({operation:'inspect_handoffs'},s.options)).rejects.toThrow();
 expect(JSON.parse(await readFile(join(s.dir,'jobs.json'),'utf8')).jobs[0].target).toBe('builder');
});
test('concurrent revision-bound edits admit one writer only',async()=>{
 const s=await setup();await applyJobsRequest({operation:'upsert',job:job(),expectedRevision:null},s.options);
 const inspected=await applyJobsRequest({operation:'inspect',id:'ops-health'},s.options);
 const results=await Promise.allSettled(['A','B'].map(prompt=>applyJobsRequest({operation:'upsert',job:{...job(),prompt},expectedRevision:inspected.revision},s.options)));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
});

async function channel(){
 const s=await setup();const keyFile=join(s.dir,'key');await writeFile(keyFile,randomBytes(32).toString('hex'),{mode:0o600});
 const client={socketPath:join(s.dir,'control.sock'),serverUid:process.getuid!(),keyFile};
 const control={socketPath:client.socketPath,grants:[{...s.options.scope,keyFile}]};
 return {...s,keyFile,client,control,send:(input:Record<string,unknown>)=>forwardScheduleRequest(input,JSON.stringify(client))};
}
test('real coordinator accepts delegated definitions without granting recipient filesystem or alternate-target authority',async()=>{
 const s=await channel();const stateRoot=join(s.dir,'state'),stateDir=join(stateRoot,'instances/personal'),coordinatorStateDir=join(s.dir,'coordinator');
 for(const p of [stateRoot,join(stateRoot,'instances'),stateDir,coordinatorStateDir])await mkdir(p,{mode:0o700});
 const config={instanceId:'personal',stateDir,coordinator:{stateRoot,coordinatorStateDir,targets:['personal'],scope:'self' as const,control:s.control}};
 const c=await startNativeJobsCoordinator(config,{logger:{info:()=>{},warn:()=>{},error:()=>{}},tickIntervalMs:20});cleanup.push(()=>c.stop());
 expect((await lstat(s.client.socketPath)).mode&0o777).toBe(0o660);
 const result=await s.send({operation:'add_at',id:'ops-reminder',target:'personal',at:'2999-01-01T00:00:00Z',prompt:'Synthetic reminder',expectedRevision:null});
 expect(result).toMatchObject({ok:true,publication:{status:'accepted'}});
 expect(await s.send({operation:'inspect',id:'ops-reminder'})).toMatchObject({publication:{status:'accepted'},revision:result.revision});
 expect(await s.send({operation:'remove',id:'ops-reminder',expectedRevision:result.revision})).toMatchObject({ok:true,publication:{status:'accepted'}});
 expect(await s.send({operation:'upsert',job:job('ops-escalation','builder'),expectedRevision:null})).toMatchObject({ok:false});
 expect(await s.send({operation:'recover_handoff',stateDir:'/other'})).toMatchObject({ok:false});
 expect(await readdir(stateDir)).not.toContain('jobs.json');
 expect(JSON.stringify(await s.send({operation:'list'}))).not.toContain(coordinatorStateDir);
 await c.stop();await expect(lstat(s.client.socketPath)).rejects.toMatchObject({code:'ENOENT'});
 const restarted=await startNativeJobsCoordinator(config,{logger:{info:()=>{},warn:()=>{},error:()=>{}},tickIntervalMs:20});cleanup.push(()=>restarted.stop());
 expect(await s.send({operation:'list'})).toMatchObject({ok:true,jobs:[]});
});
test('token grants are server-owned and unavailable authority never leaks private definitions or errors',async()=>{
 const s=await channel();await writeFile(join(s.dir,'jobs.json'),JSON.stringify({version:3,jobs:[job('private-job')]}));
 const server=await startScheduleControl(s.control,s.dir);cleanup.push(()=>server.close());
 const wrong=join(s.dir,'wrong');await writeFile(wrong,'f'.repeat(64),{mode:0o600});
 expect(await forwardScheduleRequest({operation:'list'},JSON.stringify({...s.client,keyFile:wrong}))).toMatchObject({ok:false});
 expect(await s.send({operation:'list',scope:{jobPrefix:'',targets:['personal']}})).toMatchObject({ok:false});
 expect(await s.send({operation:'inspect',id:'private-job'})).toMatchObject({ok:false});
 expect(JSON.stringify(await s.send({operation:'list'}))).not.toContain('private-job');
 const unknown=await s.send({operation:'upsert',job:{...job(),prompt:'PRIVATE_VALIDATION_INPUT',schedule:'INVALID CRON EXPRESSION'},expectedRevision:null});
 expect(unknown).toMatchObject({ok:false});expect(JSON.stringify(unknown)).not.toContain('PRIVATE_VALIDATION_INPUT');
});
test('client rejects unsafe key/socket identities and does not retry an interrupted response',async()=>{
 const s=await channel();const server=await startScheduleControl(s.control,s.dir);cleanup.push(()=>server.close());
 await expect(forwardScheduleRequest({operation:'list'},JSON.stringify({...s.client,serverUid:process.getuid!()+1}))).rejects.toThrow(/Unsafe/);
 await chmod(s.keyFile,0o644);await expect(readScheduleKey(s.keyFile)).rejects.toThrow(/Unsafe/);await chmod(s.keyFile,0o600);
 const link=join(s.dir,'link');await symlink(s.keyFile,link);await expect(readScheduleKey(link)).rejects.toThrow(/Unsafe/);
 await server.close();
 let requests=0;const dropping=createServer(socket=>{requests++;socket.once('data',()=>socket.destroy());});
 await new Promise<void>(resolve=>dropping.listen(s.client.socketPath,resolve));await chmod(s.client.socketPath,0o660);
 cleanup.push(()=>new Promise<void>(resolve=>dropping.close(()=>resolve())));
 await expect(s.send({operation:'list'})).rejects.toThrow(/outcome unknown/);expect(requests).toBe(1);
});
test('grant configuration rejects overlapping namespaces and targets beyond coordinator authority',()=>{
 const grant={jobPrefix:'ops-',targets:['personal'],keyFile:'/private/key'};
 const config={socketPath:'/run/schedule/control.sock',grants:[grant]};
 expect(parseScheduleControl(config,['personal'])).toEqual(config);
 for(const grants of [[{...grant,jobPrefix:''}],[{...grant,targets:['builder']}],[grant,{...grant,jobPrefix:'ops-sub-'}],[{...grant,extra:true}]])expect(()=>parseScheduleControl({...config,grants},['personal'])).toThrow();
});
test('transport does not confuse a saved but unacknowledged edit with host acceptance',async()=>{
 const s=await channel();const server=await startScheduleControl(s.control,s.dir);cleanup.push(()=>server.close());
 const result=await s.send({operation:'upsert',job:job(),expectedRevision:null});
 expect(result).toMatchObject({ok:true,publication:{status:'pending'}});
 expect(await s.send({operation:'inspect',id:'ops-health'})).toMatchObject({revision:result.revision,publication:{status:'pending'}});
},8000);
test('a response lost after saving is reconciled by inspection, never an automatic second write',async()=>{
 const s=await channel();let attempts=0;
 const dropping=createHttpServer(async(req)=>{
  attempts++;const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  await applyJobsRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')),s.options);
  req.socket.destroy();
 });
 await new Promise<void>(resolve=>dropping.listen(s.client.socketPath,resolve));await chmod(s.client.socketPath,0o660);
 cleanup.push(()=>new Promise<void>(resolve=>dropping.close(()=>resolve())));
 await expect(s.send({operation:'upsert',job:job(),expectedRevision:null})).rejects.toThrow(/outcome unknown/);
 expect(attempts).toBe(1);
 await new Promise<void>(resolve=>dropping.close(()=>resolve()));
 const server=await startScheduleControl(s.control,s.dir);cleanup.push(()=>server.close());
 const inspected=await s.send({operation:'inspect',id:'ops-health'});
 expect(inspected).toMatchObject({ok:true,job:job(),publication:{status:'pending'}});
 expect(inspected.revision).toMatch(/^[a-f0-9]{64}$/);
 expect(await s.send({operation:'upsert',job:job(),expectedRevision:null})).toMatchObject({ok:false});
});
test('control lifecycle refuses a live listener and recovers its owned stale socket after process death',async()=>{
 const s=await channel();const child=spawn(process.execPath,['--input-type=module','-e',`import {createServer} from 'node:net'; createServer().listen(${JSON.stringify(s.client.socketPath)},()=>process.stdout.write('READY'));`],{stdio:['ignore','pipe','pipe']});
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 cleanup.push(async()=>{if(child.exitCode===null)child.kill('SIGKILL');await closed;});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture did not listen')),3000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
 await expect(startScheduleControl(s.control,s.dir)).rejects.toThrow(/already listening/);
 expect((await lstat(s.client.socketPath)).isSocket()).toBe(true);
 child.kill('SIGKILL');await closed;
 const server=await startScheduleControl(s.control,s.dir);cleanup.push(()=>server.close());
 expect(await s.send({operation:'list'})).toMatchObject({ok:true});
});
test('listing is bounded, advertises the grant and excludes unexpected private fields',async()=>{
 const s=await setup();const jobs=Array.from({length:25},(_,i)=>job(`ops-${i}`));
 await writeFile(join(s.dir,'jobs.json'),JSON.stringify({version:3,jobs:[...jobs,{...job('ops-extra'),privateKey:'NEVER_EXPOSE'}]}));
 const first=await applyJobsRequest({operation:'list'},s.options);
 expect(first).toMatchObject({grant:{jobPrefix:'ops-',targets:['personal'],jobTypes:['cron','at']},nextOffset:20});
 expect(first.jobs).toHaveLength(20);expect(JSON.stringify(first)).not.toContain('Read-only health review');
 const second=await applyJobsRequest({operation:'list',offset:20},s.options);
 expect(second.jobs).toHaveLength(5);expect(second.nextOffset).toBeNull();
 expect(JSON.stringify(second)).not.toContain('NEVER_EXPOSE');
 await expect(applyJobsRequest({operation:'inspect',id:'ops-extra'},s.options)).rejects.toThrow();
});
