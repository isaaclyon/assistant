import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Type, type Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { context, fullStorage, gate, openPilot, untilReleased, wakeQueue } from './runtime.mjs';

const cleanups: Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const clean of cleanups.splice(0).reverse()) await clean();});
async function directory(){const root=await mkdtemp(join(tmpdir(),'native-c1-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));return root;}
async function pilot(options:any={}){const path=join(await directory(),'harness.db');const p=await openPilot(path,options);cleanups.push(()=>p.close());return {...p,path};}
function heldTool(){
  const started=gate(),hold=gate();
  const registry=createRegistry();
  registry.install(defineExtension({name:'synthetic-read',tools:[defineTool({name:'read_fixture',description:'Read a synthetic fixture',parameters:Type.Object({}),replay:'safe',
    execute:async(_args,_api,ctx)=>{started.resolve(undefined);await untilReleased(hold,ctx.abortSignal);return {output:[{type:'text',text:'FIXTURE'}]};},
  })]}));
  return {registry,started,hold};
}

registerStorageConformance({describe,expect,it},'public Node SQLite WAL/FULL',async use=>{
  const root=await mkdtemp(join(tmpdir(),'native-conformance-'));const {storage}=await fullStorage(join(root,'store.db'));
  try{await use(storage);}finally{await storage.close(context);await rm(root,{recursive:true,force:true});}
});

describe('native public-API control probes',()=>{
  it('reopens WAL/FULL and deduplicates a committed input and answer without a delivery listener',async()=>{
    const p=await pilot();
    const first=await p.root.submit({type:'input',content:'Synthetic baseline question',requestId:'same-source'},context);
    const settled=await first.wait(context);expect(settled.status).toBe('done');
    await p.close();
    const next=await openPilot(p.path);cleanups.push(()=>next.close());
    expect(await next.database.get('PRAGMA synchronous')).toEqual({synchronous:2});
    const again=await next.root.submit({type:'input',content:'Synthetic baseline question',requestId:'same-source'},context);
    expect(again.id).toBe(first.id);expect(await again.wait(context)).toEqual(settled);
    expect(next.faux.state.callCount).toBe(0);
    const entries=await next.root.entries({},100,undefined,context);
    expect(entries.items.filter(e=>e.kind==='pi.user')).toHaveLength(1);
    expect(entries.items.some(e=>e.id===(settled as any).answer)).toBe(true);
  });

  it('advances a failed-run FIFO with an empty model control write, deduplicated across reopen',async()=>{
    const t=heldTool();
    const p=await pilot({registry:t.registry,responses:[answer(fauxToolCall('read_fixture',{}),{stopReason:'toolUse'}),answer('',{stopReason:'error',errorMessage:'synthetic terminal failure'}),answer('SECOND'),answer('THIRD')]});
    const first=await p.root.submit({type:'input',content:'FIRST',requestId:'first'},context);
    await t.started.promise;
    const second=await p.root.submit({type:'input',content:'SECOND',requestId:'second',whenBusy:'followUp'},context);
    const third=await p.root.submit({type:'input',content:'THIRD',requestId:'third',whenBusy:'followUp'},context);
    t.hold.resolve(undefined);
    expect(await first.wait(context)).toMatchObject({status:'unanswered'});
    expect(await second.status(context)).toMatchObject({status:'queued'});
    await p.close();
    const next=await openPilot(p.path,{registry:t.registry,responses:[answer('SECOND'),answer('THIRD')]});cleanups.push(()=>next.close());
    const wake=await wakeQueue(next.root,first.id);
    expect((await wakeQueue(next.root,first.id)).id).toBe(wake.id);
    expect(await (await next.harness.submission(second.id,context))!.wait(context)).toMatchObject({status:'done'});
    expect(await (await next.harness.submission(third.id,context))!.wait(context)).toMatchObject({status:'done'});
    expect(next.faux.state.callCount).toBe(2);
    expect(next.requests[0]!.messages.filter((m:Message)=>m.role==='user').map((m:Message)=>m.content)).toEqual(['FIRST','SECOND']);
    const view=await next.root.context(context);
    expect(view.entries.filter(e=>e.kind==='bridge.queue-wake')).toHaveLength(1);
    expect(view.messages.filter((m:Message)=>m.role==='user').map((m:Message)=>m.content)).toEqual(['FIRST','SECOND','THIRD']);
    await wakeQueue(next.root,'empty-queue');await next.root.waitForIdle(context);
    expect(next.faux.state.callCount).toBe(2);
  });

  it.each(['wake-first','input-first'] as const)('preserves FIFO when failure wake races a new input: %s',async order=>{
    const t=heldTool();const p=await pilot({registry:t.registry,responses:[answer(fauxToolCall('read_fixture',{}),{stopReason:'toolUse'}),answer('',{stopReason:'error',errorMessage:'synthetic failure'}),answer('SECOND'),answer('THIRD')]});
    const first=await p.root.submit({type:'input',content:'FIRST',requestId:'first'},context);await t.started.promise;
    const second=await p.root.submit({type:'input',content:'SECOND',requestId:'second',whenBusy:'followUp'},context);
    t.hold.resolve(undefined);expect(await first.wait(context)).toMatchObject({status:'unanswered'});
    const enqueue=()=>p.root.submit({type:'input',content:'THIRD',requestId:'third',whenBusy:'followUp'},context);
    const wake=()=>wakeQueue(p.root,first.id);
    await Promise.all(order==='wake-first'?[wake(),enqueue(),wake()]:[enqueue(),wake(),wake()]);
    const third=await enqueue();await Promise.all([second.wait(context),third.wait(context)]);
    expect(p.requests[2]!.messages.filter((m:Message)=>m.role==='user').map((m:Message)=>m.content)).toEqual(['FIRST','SECOND']);
    expect(p.requests[3]!.messages.filter((m:Message)=>m.role==='user').map((m:Message)=>m.content)).toEqual(['FIRST','SECOND','THIRD']);
    expect(p.faux.state.callCount).toBe(4);
    const entries=(await p.root.entries({},100,undefined,context)).items;
    expect(entries.filter(e=>e.kind==='pi.user')).toHaveLength(3);expect(entries.filter(e=>e.kind==='bridge.queue-wake')).toHaveLength(1);
  });

  it('keeps ordinary follow-ups out of tool boundaries while explicit steering joins them',async()=>{
    const t=heldTool();
    const p=await pilot({registry:t.registry,responses:[answer(fauxToolCall('read_fixture',{}),{stopReason:'toolUse'}),answer('FIRST+STEER'),answer('FOLLOW')]});
    const first=await p.root.submit({type:'input',content:'FIRST'},context);await t.started.promise;
    const follow=await p.root.submit({type:'input',content:'FOLLOW',whenBusy:'followUp'},context);
    const steer=await p.root.submit({type:'input',content:'STEER',whenBusy:'steer'},context);
    t.hold.resolve(undefined);await Promise.all([first.wait(context),follow.wait(context),steer.wait(context)]);
    expect(p.requests[1]!.messages.filter((m:Message)=>m.role==='user').map((m:Message)=>m.content)).toEqual(['FIRST','STEER']);
    expect(p.requests[2]!.messages.filter((m:Message)=>m.role==='user').map((m:Message)=>m.content)).toEqual(['FIRST','STEER','FOLLOW']);
  });

  it.each(['abort','stop'] as const)('%s chooses active-task cancellation or conversation-wide withdrawal explicitly',async control=>{
    const t=heldTool();const p=await pilot({registry:t.registry,responses:[answer(fauxToolCall('read_fixture',{}),{stopReason:'toolUse'}),answer('NEXT')]});
    const active=await p.root.submit({type:'input',content:'ACTIVE'},context);await t.started.promise;
    const queued=await p.root.submit({type:'input',content:'QUEUED',whenBusy:'followUp'},context);
    if(control==='stop')await p.root.abort(context);
    else{
      const view=await p.root.viewState(context);const live=(view.value.docs['pi.live'] as any).run;view.dispose();
      await p.harness.abortTask(live.taskId,context);await active.wait(context);
    }
    expect(await active.status(context)).toMatchObject({status:'unanswered'});
    if(control==='stop')expect(await queued.status(context)).toMatchObject({status:'unanswered',reason:'aborted'});
    else{expect(await queued.status(context)).toMatchObject({status:'queued'});await wakeQueue(p.root,active.id);expect(await queued.wait(context)).toMatchObject({status:'done'});}
  });

  it('blocks missing task definitions on reopen and resumes only after registration',async()=>{
    const rootDir=await directory();const path=join(rootDir,'tasks.db');
    const task=defineTask<{}, {phase:'run'}, string>({name:'probe.registered',version:1,initial:()=>({phase:'run'}),phases:{run:async(_task,runtime,ctx)=>{await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:'DONE'}}),ctx);}},abort:async(_task,runtime,ctx)=>{await runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),ctx);}});
    const registry=createRegistry();registry.install(defineExtension({name:'registered',tasks:[task]}));
    const p=await openPilot(path,{registry});
    const taskId=await p.root.commit(tx=>tx.createTask(task,{}, {ownership:{kind:'conversation'},conversationId:p.root.id}),context);
    await p.close();
    const next=await openPilot(path);cleanups.push(()=>next.close());
    expect((await next.harness.inspect(context)).tasks.find(x=>x.record.id===taskId)?.state).toMatchObject({kind:'blocked',reason:'missing_task'});
    next.registry.install(defineExtension({name:'registered',tasks:[task]}));next.harness.resume();
    expect((await next.harness.waitForTask(taskId,context)).state).toMatchObject({status:'terminal',outcome:{status:'completed',result:'DONE'}});
  });
});
