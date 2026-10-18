import { fork, execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { generalCrashFixture } from './general-crash-fixture.js';
import { DurableHost } from '../../src/durable/host.js';
import { Bindings, context } from '../../src/durable/ingress.js';
let compiled:string;
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
beforeAll(async()=>{
  const cache=join(process.cwd(),'node_modules/.cache');await mkdir(cache,{recursive:true});compiled=await mkdtemp(join(cache,'host-crash-'));
  await promisify(execFile)(process.execPath,['node_modules/typescript/bin/tsc','--strict','--skipLibCheck','--module','nodenext','--target','es2023','--rootDir','.', '--outDir',compiled,...['host','ingress','storage','delivery','recovery'].map(name=>`src/durable/${name}.ts`),'tests/durable/general-crash-fixture.ts'],{timeout:30_000});
},35_000);
afterAll(async()=>{if(compiled)await rm(compiled,{recursive:true,force:true});});
async function directory(){const path=await mkdtemp(join(tmpdir(),'host-crash-'));cleanup.push(()=>rm(path,{recursive:true,force:true}));return path;}
function worker(path:string,mode:string){
  const child=fork(join(process.cwd(),'tests/durable/host-crash-worker.mjs'),[compiled,path,mode],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr!.on('data',chunk=>stderr+=String(chunk));
  const messages:Record<string,unknown>[]=[];const listeners=new Set<()=>void>();child.on('message',message=>{messages.push(message as Record<string,unknown>);for(const fn of listeners)fn();});
  const exited=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const wait=(event:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{const timeout=setTimeout(()=>{listeners.delete(check);reject(new Error(`Missing ${event}: ${stderr}`));},5000);const check=()=>{const message=messages.find(m=>m.event===event);if(message){clearTimeout(timeout);listeners.delete(check);resolve(message);}};listeners.add(check);check();});
  return {child,wait,exited};
}
async function open(path:string){
  const faux=fauxProvider({tokensPerSecond:1e9});faux.setResponses([fauxAssistantMessage('RECOVERED')]);const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();let sends=0;
  const host=await DurableHost.create({stateDir:path,models,registry:createRegistry(),agent:{model:{provider:model.provider,modelId:model.id}},compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:'fixture',registrySignature:'fixture-v1'},transport:{async start(){},async stop(){},async sendFinal(){return {messageId:++sends};}},policy(){},controlPolicy(){},settings:{retry:{enabled:false},compaction:{enabled:false}}});cleanup.push(()=>host.close());return host;
}
it('SIGKILL releases the OS writer and reconciles admitted inbox receipt exactly once',async()=>{
  const path=await directory(),child=worker(path,'admitted');await child.wait('admitted');await expect(open(path)).rejects.toThrow();child.child.kill('SIGKILL');expect(await child.exited).toMatchObject({signal:'SIGKILL'});
  const host=await open(path);expect(host.runtime.store.inbox.pending()).toHaveLength(1);await host.start();
  const binding=Object.values((await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context))!.sources)[0]!;
  expect(await (await host.runtime.harness.submission(binding.submissionId!,context))!.wait(context)).toMatchObject({status:'done'});
  expect(host.runtime.store.inbox.pending()).toHaveLength(0);
  const conversation=(await host.runtime.harness.conversation(binding.conversationId,context))!;
  expect((await conversation.entries({},100,undefined,context)).items.filter(e=>e.kind==='bridge.source')).toHaveLength(1);
});
it('fatal storage closes acceptance immediately and the supervisor exits despite noncooperative tool code',async()=>{
  const path=await directory(),child=worker(path,'fatal');expect(await child.wait('failed-closed')).toMatchObject({health:'failed',rejected:true,laterRejected:true,reports:1});expect(await child.exited).toEqual({code:42,signal:null});
  const host=await open(path);const state=await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context);expect(Object.values(state!.sources)).toHaveLength(1);expect(JSON.stringify(state)).not.toContain('MUST_NOT_ACCEPT');
});

it('bounds control cancellation when a tool ignores its abort signal',async()=>{
  const path=await directory(),child=worker(path,'control-timeout');expect(await child.wait('control-timeout')).toMatchObject({health:'failed',rejected:true,reports:1});expect(await child.exited).toEqual({code:42,signal:null});
});


it.each(['bash','write','read'])('real %s interrupted after effect obeys its replay policy after SIGKILL',async name=>{
 const path=await directory(),child=worker(path,`general-${name}`);await child.wait('effect');
 child.child.kill('SIGKILL');expect(await child.exited).toMatchObject({signal:'SIGKILL'});
 const faux=fauxProvider({tokensPerSecond:1e9});const responses:any[]=[];
 faux.setResponses([(request:any)=>{responses.push(request);return fauxAssistantMessage('RECOVERED');}]);
 const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
 let host!:DurableHost;const fixture=await generalCrashFixture(path,()=>host);
 host=await DurableHost.create({stateDir:path,models,registry:fixture.registry,env:()=>fixture.env,agent:{model:{provider:model.provider,modelId:model.id},cwd:path},compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:'fixture',registrySignature:'fixture-v1'},transport:{async start(){},async stop(){},async sendFinal(){return {messageId:1};}},policy(){},controlPolicy(){},settings:{retry:{enabled:false},compaction:{enabled:false}}});
 cleanup.push(async()=>{try{await host.close();}finally{try{await fixture.close();}finally{await fixture.env.cleanup(context);}}});
 await host.start();
 const state=(await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context))!;
 const binding=Object.values(state.sources)[0]!;
 expect(await (await host.runtime.harness.submission(binding.submissionId!,context))!.wait(context)).toMatchObject({status:'done'});
 expect(await readFile(join(path,'attempts'),'utf8')).toBe(name==='read'?'attempt\nattempt\n':'attempt\n');
 expect(await readFile(join(path,'authority-checks'),'utf8')).toBe(name==='read'?'check\ncheck\n':'check\n');
 if(name!=='read')expect(await readFile(join(path,'effect'),'utf8')).toBe(name==='bash'?'x':'WRITTEN');
 const toolResult=responses[0].messages.find((message:any)=>message.role==='toolResult');
 expect(toolResult.isError??false).toBe(name!=='read');
 if(name==='read')expect(JSON.stringify(toolResult)).toContain('SAFE_READ');
});

it('recovered safe read rechecks current epoch authority before repeating filesystem access',async()=>{
 const path=await directory(),child=worker(path,'general-read');await child.wait('effect');child.child.kill('SIGKILL');await child.exited;
 const faux=fauxProvider({tokensPerSecond:1e9});faux.setResponses([fauxAssistantMessage('AUTHORITY_CHECKED')]);const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
 let host!:DurableHost;const fixture=await generalCrashFixture(path,()=>host);
 host=await DurableHost.create({stateDir:path,models,registry:fixture.registry,env:()=>fixture.env,agent:{model:{provider:model.provider,modelId:model.id},cwd:path},compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:'fixture',registrySignature:'fixture-v1'},transport:{async start(){},async stop(){},async sendFinal(){return {messageId:1};}},policy(){},controlPolicy(){},settings:{retry:{enabled:false},compaction:{enabled:false}}});
 cleanup.push(async()=>{try{await host.close();}finally{try{await fixture.close();}finally{await fixture.env.cleanup(context);}}});
 await host.runtime.root.commit(async tx=>{(await tx.doc(Bindings,host.runtime.root.id)).epoch++;},context);
 await host.start();const binding=Object.values((await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context))!.sources)[0]!;
 expect(await (await host.runtime.harness.submission(binding.submissionId!,context))!.wait(context)).toMatchObject({status:'done'});
 expect(await readFile(join(path,'authority-checks'),'utf8')).toBe('check\ncheck\n');
 expect(await readFile(join(path,'attempts'),'utf8')).toBe('attempt\n');
});
