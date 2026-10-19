import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openInbox } from '../../../src/inbox.js';
import { accept, admit, Bindings, reserveNextEpoch, sourceKey } from './ingress.mjs';
import { context, openPilot } from './runtime.mjs';

const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const clean of cleanups.splice(0).reverse())await clean();});
async function directory(){const dir=await mkdtemp(join(tmpdir(),'native-crash-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));return dir;}
function worker(mode:string,dir:string){
  const child=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[mode,dir],{stdio:['ignore','ignore','pipe','ipc']});
  let error='';child.stderr!.on('data',chunk=>error=(error+chunk.toString()).slice(-16000));
  const messages:any[]=[];const listeners=new Set<()=>void>();
  child.on('message',message=>{messages.push(message);for(const listener of listeners)listener();});
  const exited=new Promise<{code:number|null,signal:string|null}>(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
  const wait=(event:string)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{listeners.delete(check);reject(new Error(`Missing ${event}: ${error}`));},5000);
    const check=()=>{const found=messages.find(m=>m.event===event);if(found){clearTimeout(timer);listeners.delete(check);resolve(found);}};
    listeners.add(check);check();
  });
  cleanups.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  return {child,wait,exited};
}
const envelope={instance:'test-instance',bot:'test-bot',chatId:100,threadId:7,messageIds:[11,12],attachments:[{fileId:'opaque-fixture',fileUniqueId:'stable-fixture',fileName:'fixture.txt',mimeType:'text/plain'}],originalAt:1700000000000,content:'Synthetic accepted input'};

it('kills after admission before receipt/removal and recovers one submission at its original target/time',async()=>{
  const dir=await directory();await writeFile(join(dir,'envelope.json'),JSON.stringify(envelope));
  const child=worker('admitted',dir);await child.wait('accepted');const admitted=await child.wait('admitted');
  child.child.kill('SIGKILL');expect(await child.exited).toMatchObject({signal:'SIGKILL'});
  let reads=0;const registry=createRegistry();registry.install(defineExtension({name:'read',tools:[defineTool({name:'read_fixture',description:'Read fixture',parameters:Type.Object({}),replay:'safe',execute:async()=>{reads++;return {output:[{type:'text',text:'FIXTURE'}]};}})]}));
  const p=await openPilot(join(dir,'harness.db'),{registry,responses:[answer(fauxToolCall('read_fixture',{}),{stopReason:'toolUse'}),answer('RECOVERED')]});cleanups.push(()=>p.close());
  const inbox=openInbox(join(dir,'inbox.db'));cleanups.push(async()=>inbox.close());
  expect(inbox.loadPending()).toHaveLength(1);
  const before=await p.harness.snapshot(Bindings,p.root.id,context);
  expect(before!.sources[sourceKey(envelope)]).not.toHaveProperty('submissionId');
  await reserveNextEpoch(p); // a current conversation change must not remap the accepted old source
  const recovered=await admit(p,inbox,envelope);
  expect(recovered.submission.id).toBe(admitted.submissionId);
  expect(await recovered.submission.wait(context)).toMatchObject({status:'done'});expect(reads).toBe(1);
  expect(inbox.loadPending()).toEqual([]);
  const entries=await recovered.conversation.entries({},100,undefined,context);
  const sources=entries.items.filter((e:any)=>e.kind==='bridge.source');expect(sources).toHaveLength(1);
  expect(sources[0]!.data).toMatchObject({originalAt:envelope.originalAt,chatId:100,threadId:7,attachments:envelope.attachments});
  const replayBinding=await accept(p,inbox,envelope);expect(replayBinding.binding.epoch).toBe(0);
  const replay=await admit(p,inbox,envelope);expect(replay.submission.id).toBe(admitted.submissionId);
  expect(await replay.submission.wait(context)).toMatchObject({status:'done'});expect(reads).toBe(1);
  expect((await replay.conversation.entries({},100,undefined,context)).items.filter((e:any)=>e.kind==='bridge.source')).toHaveLength(1);
  await expect(accept(p,inbox,{...envelope,attachments:[{...envelope.attachments[0],fileId:'changed'}]})).rejects.toThrow('payload conflict');
  await expect(accept(p,inbox,{...envelope,content:'CHANGED'})).rejects.toThrow('payload conflict');
  let acknowledged=false;
  const newEnvelope={...envelope,messageIds:[12],originalAt:envelope.originalAt+1000};
  const next=await accept(p,inbox,newEnvelope,()=>{expect(inbox.loadPending()).toHaveLength(1);acknowledged=true;});
  expect(acknowledged).toBe(true);expect(next.binding.epoch).toBe(1);
  expect(next.binding.conversationId).not.toBe(recovered.conversation.id);
});

it('does not rerun a read tool whose result committed before SIGKILL',async()=>{
  const dir=await directory();const child=worker('read-committed',dir);await child.wait('read-committed');child.child.kill('SIGKILL');await child.exited;
  let repeated=0;const registry=createRegistry();registry.install(defineExtension({name:'read',tools:[defineTool({name:'read_fixture',description:'Read fixture',parameters:Type.Object({}),replay:'safe',execute:async()=>{repeated++;return {output:[{type:'text',text:'UNEXPECTED_REPEAT'}]};}})]}));
  const p=await openPilot(join(dir,'harness.db'),{registry});cleanups.push(()=>p.close());
  expect((await p.root.entries({},100,undefined,context)).items.filter(e=>e.kind==='pi.tool-result')).toHaveLength(1);
  const again=await p.root.submit({type:'input',content:'Read fixture',requestId:'read-source'},context);
  expect(await again.wait(context)).toMatchObject({status:'done'});expect(repeated).toBe(0);
  expect(await readFile(join(dir,'read-count'),'utf8')).toBe('1');
});

it('rejects new acceptance after storage failure and forces bounded exit when tool code ignores cancellation',async()=>{
  const dir=await directory();const child=worker('fatal',dir);
  expect(await child.wait('failed-closed')).toMatchObject({rejected:true,laterRejected:true,reports:1});
  expect(await child.exited).toEqual({code:42,signal:null});
  const p=await openPilot(join(dir,'harness.db'));cleanups.push(()=>p.close());
  expect((await p.root.entries({},100,undefined,context)).items.some(e=>JSON.stringify(e).includes('MUST_NOT_ACCEPT'))).toBe(false);
});

it('closes and retires a separate child store without deleting durable parent correlation',async()=>{
  const parentDir=await directory(),childDir=await directory();const p=await openPilot(join(parentDir,'parent.db'));cleanups.push(()=>p.close());
  const child=worker('child',childDir);const ready=await child.wait('child-ready');
  await p.root.submit({type:'write',entry:{kind:'probe.child-receipt',data:{childId:'synthetic-child',conversationId:ready.conversationId,status:'completed',createdAt:1}}},context);
  child.child.send('close');await child.wait('closed');expect(await child.exited).toEqual({code:0,signal:null});
  await rm(childDir,{recursive:true});await expect(stat(childDir)).rejects.toMatchObject({code:'ENOENT'});
  await p.close();const reopened=await openPilot(join(parentDir,'parent.db'));cleanups.push(()=>reopened.close());
  const entries=(await reopened.root.entries({},100,undefined,context)).items;
  expect(entries.some(e=>e.kind==='probe.child-receipt')).toBe(true);
  expect(JSON.stringify(entries)).not.toContain('PRIVATE_CHILD_TRANSCRIPT');
});
