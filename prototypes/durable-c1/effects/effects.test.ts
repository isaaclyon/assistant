import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { open, context, State, prepareApproval, callback } from './runtime.mjs';
const dirs:string[]=[];
const children=new Set<ChildProcess>();
afterEach(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}}children.clear();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function directory(){const dir=await mkdtemp(join(tmpdir(),'c1-effects-'));dirs.push(dir);return dir;}
async function crash(dir:string, missing=false):Promise<string>{
 const child=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[dir,missing?'missing':'receipt'],{stdio:['ignore','pipe','pipe','ipc']});children.add(child);
 let errors='';child.stderr?.on('data',chunk=>{errors+=String(chunk);});
 const taskId=await new Promise<string>((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`Crash barrier timeout: ${errors}`));},10000);
  child.once('error',e=>{clearTimeout(timer);reject(e);});
  child.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error(`Exited before barrier ${code}/${signal}: ${errors}`));});
  child.on('message',(message:unknown)=>{const event=message as {event:string;taskId:string};if(event.event==='external-succeeded'){clearTimeout(timer);resolve(event.taskId);}});
 });
 const exited=once(child,'exit');child.kill('SIGKILL');expect((await exited)[1]).toBe('SIGKILL');children.delete(child);return taskId;
}
for(const missing of [false,true]) test(`native tool recovers external effect after SIGKILL (${missing?'missing receipt':'receipt'})`,async()=>{
 const dir=await directory();const taskId=await crash(dir,missing);const app=await open(dir);
 try {
  const before=await app.harness.getTask(taskId as never,context);
  expect(before?.state).toMatchObject({checkpoint:{phase:'execute',replay:'safe'}});
  expect((await app.harness.snapshot(State,app.root.id,context))?.operation).toMatchObject({id:'operation-1',status:'executing',taskId});
  expect((await app.root.entries({},100,undefined,context)).items.filter((e:{kind:string})=>e.kind==='pi.tool-result')).toHaveLength(0);
  expect((await app.harness.waitForTask(taskId as never,context)).state.outcome.status).toBe('completed');
  expect((await app.harness.snapshot(State,app.root.id,context))?.operation).toMatchObject({id:'operation-1',status:missing?'uncertain':'reconciled',taskId});
  expect(app.external.prepare('SELECT value FROM counter').get()).toEqual({value:1});
  const results=(await app.root.entries({},100,undefined,context)).items.filter((e:{kind:string})=>e.kind==='pi.tool-result');
  expect(results).toHaveLength(1);expect(JSON.stringify(results)).toContain(missing?'uncertain':'reconciled');
 }finally{await app.close();}
 // Completed native task is not rerun on a second restart.
 const again=await open(dir);try{await again.harness.waitForIdle(context);expect(again.external.prepare('SELECT value FROM counter').get()).toEqual({value:1});}finally{await again.close();}
},20000);

test('same-epoch approval survives restart; wrong actor/chat and replay cannot mutate',async()=>{
 const dir=await directory();
 const child=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[dir,'approval'],{stdio:['ignore','ignore','pipe','ipc']});children.add(child);
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try {expect((await once(child,'exit'))[0]).toBe(0);}finally{clearTimeout(timer);}
 children.delete(child);
 let app=await open(dir);
 try {
  expect(await callback(app,{actor:'intruder'})).toEqual({accepted:false});
  expect(await callback(app,{chat:'wrong-chat'})).toEqual({accepted:false});
  expect(app.external.prepare('SELECT value FROM counter').get()).toEqual({value:0});
  const accepted=await callback(app);expect(accepted.accepted).toBe(true);
  expect((await app.harness.waitForTask(accepted.taskId as never,context)).state.outcome.status).toBe('completed');
  expect(app.external.prepare('SELECT value FROM counter').get()).toEqual({value:1});
 }finally{await app.close();}
 app=await open(dir);try{expect(await callback(app)).toEqual({accepted:false});await app.harness.waitForIdle(context);expect(app.external.prepare('SELECT value FROM counter').get()).toEqual({value:1});}finally{await app.close();}
});
for(const invalid of ['expired','rotated','revoked','stale-revision','wrong-version','unpresented'])test(`persisted ${invalid} approval is rejected after restart`,async()=>{
 const dir=await directory();let app=await open(dir);await prepareApproval(app);
 await app.root.commit(async tx=>{const state=await tx.doc(State,app.root.id);if(invalid==='rotated')state.epoch='epoch-2';if(invalid==='revoked')state.revoked=true;if(invalid==='unpresented')state.approval!.presented=false;},context);
 await app.close();app=await open(dir);
 try{expect(await callback(app,invalid==='expired'?{now:601000}:invalid==='stale-revision'?{revision:'rev-2'}:invalid==='wrong-version'?{version:2}:{})).toEqual({accepted:false});await app.harness.waitForIdle(context);expect(app.external.prepare('SELECT value FROM counter').get()).toEqual({value:0});}finally{await app.close();}
});
