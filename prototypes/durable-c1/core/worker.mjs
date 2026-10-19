// Synthetic crash/close barriers. Never start a transport or read ambient credentials.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openPilot, context, gate } from './runtime.mjs';
import { accept, admit } from './ingress.mjs';
const {openInbox}=await import(new URL('../../../src/inbox.ts',import.meta.url).href);
const [mode,dir]=process.argv.slice(2);
const send=message=>new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve()));
const forever=()=>new Promise(()=>{});
if(mode==='admitted'){
  const p=await openPilot(join(dir,'harness.db'),{responses:[forever]});
  const inbox=openInbox(join(dir,'inbox.db'));
  const envelope=JSON.parse(await readFile(join(dir,'envelope.json'),'utf8'));
  await accept(p,inbox,envelope,async()=>send({event:'accepted'}));
  await admit(p,inbox,envelope,{beforeReceipt:async submission=>{await send({event:'admitted',submissionId:submission.id});await forever();}});
}else if(mode==='read-committed'){
  const registry=createRegistry();
  registry.install(defineExtension({name:'read',tools:[defineTool({name:'read_fixture',description:'Read fixture',parameters:Type.Object({}),replay:'safe',
    execute:async()=>{await writeFile(join(dir,'read-count'),'1');return {output:[{type:'text',text:'READ_RESULT'}]};}})]}));
  const p=await openPilot(join(dir,'harness.db'),{registry,responses:[answer(fauxToolCall('read_fixture',{}),{stopReason:'toolUse'}),async()=>{await send({event:'read-committed'});await forever();}]});
  await p.root.submit({type:'input',content:'Read fixture',requestId:'read-source'},context);
}else if(mode==='fatal'){
  let fail=false;const started=gate();const registry=createRegistry();
  registry.install(defineExtension({name:'stuck',tools:[defineTool({name:'stuck_tool',description:'Ignores cancellation deliberately',parameters:Type.Object({}),replay:'safe',execute:async()=>{started.resolve();await forever();}})]}));
  const p=await openPilot(join(dir,'harness.db'),{registry,responses:[answer(fauxToolCall('stuck_tool',{}),{stopReason:'toolUse'})],wrapStorage:storage=>new Proxy(storage,{get(target,key){
    if(key==='commit')return (...args)=>fail?Promise.reject(new Error('SYNTHETIC_STORAGE_FAILURE')):target.commit(...args);
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }})});
  await p.root.submit({type:'input',content:'Stuck'},context);await started.promise;fail=true;
  let rejected=false;try{await p.root.submit({type:'write',entry:{kind:'probe.trigger'}},context);}catch{rejected=true;}
  let laterRejected=false;try{await p.root.submit({type:'input',content:'MUST_NOT_ACCEPT'},context);}catch{laterRejected=true;}
  await send({event:'failed-closed',rejected,laterRejected,reports:p.reports.length});
  // Prototype supervisor: fatal state closes admission immediately; force exit if a tool ignores abort.
  const watchdog=setTimeout(()=>process.exit(42),150);
  await p.harness.closed;clearTimeout(watchdog);process.exit(0);
}else if(mode==='child'){
  const lease=join(dir,'writer.lease');await mkdir(lease); // prototype exclusive-start gate, no stale lease recovery
  const p=await openPilot(join(dir,'child.db'));
  await (await p.root.submit({type:'input',content:'PRIVATE_CHILD_TRANSCRIPT'},context)).wait(context);
  await send({event:'child-ready',conversationId:p.root.id});
  process.once('message',async message=>{if(message==='close'){await p.close();await rm(lease,{recursive:true});await send({event:'closed'});process.disconnect();}});
}else{throw new Error('Unknown fixture mode');}
