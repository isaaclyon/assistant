import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { AgentDoc, createRegistry, defineTask } from '@earendil-works/pi-durable';
import { loadCapabilityProfile } from '../../../src/capabilities.js';
import { openInbox } from '../../../src/inbox.js';
import { accept, admit, Bindings, sourceKey } from './ingress.mjs';
import { resolveLocator } from './history.mjs';
import { context, openPilot } from './runtime.mjs';
import { Deliveries, deliver, discoverDeliveries } from './delivery.mjs';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const clean of cleanups.splice(0).reverse())await clean();});
async function directory(){const root=await mkdtemp(join(tmpdir(),'native-boundary-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));return root;}

it('discovers completed answers and original destinations after losing listener and admission receipt',async()=>{
  const dir=await directory(),path=join(dir,'db');const p=await openPilot(path);
  const envelope={instance:'fixture',bot:'bot',chatId:100,threadId:7,messageIds:[9],originalAt:1,content:'Synthetic input'};
  const inbox=openInbox(join(dir,'inbox.db'));cleanups.push(async()=>inbox.close());
  await accept(p,inbox,envelope);await (await admit(p,inbox,envelope)).submission.wait(context);
  await p.root.commit(async tx=>{delete (await tx.doc(Bindings,p.root.id)).sources[sourceKey(envelope)]!.submissionId;},context);
  await p.close();
  const next=await openPilot(path);cleanups.push(()=>next.close());let calls=0;
  // The scanner receives neither a submission ID nor a destination from memory.
  expect(await discoverDeliveries(next,async()=>{calls++;throw Object.assign(new Error('before sending'),{definitelyNotSent:true});})).toMatchObject([{status:'retryable'}]);
  const recovered=await discoverDeliveries(next,async({target}:any)=>{calls++;expect(target).toEqual({chatId:100,threadId:7});return {messageId:9};});
  expect(recovered).toMatchObject([{status:'delivered'}]);
  expect(await discoverDeliveries(next,async()=>{calls++;return {messageId:10};})).toMatchObject([{status:'delivered'}]);expect(calls).toBe(2);
  await expect(deliver(next,recovered[0]!.submissionId,{chatId:200},async()=>({messageId:1}))).rejects.toThrow('Destination changed');
  expect(next.faux.state.callCount).toBe(0);
});

it.each(['lost-ack','sending-at-crash','missing-ack'] as const)('keeps %s uncertain across restart without sending twice',async mode=>{
  const dir=await directory(),path=join(dir,'db');const p=await openPilot(path);const target={chatId:100,threadId:7};let remoteAccepts=0;
  const submission=await p.root.submit({type:'input',content:'Synthetic input'},context);const done=await submission.wait(context);
  if(mode==='sending-at-crash')await p.root.commit(async tx=>{(await tx.doc(Deliveries,p.root.id)).items[`answer:${submission.id}`]={status:'sending',target,answerId:(done as any).answer};},context);
  else expect(await deliver(p,submission.id,target,async()=>{remoteAccepts++;if(mode==='lost-ack')throw new Error('after remote acceptance');})).toBe('uncertain');
  await p.close();const next=await openPilot(path);cleanups.push(()=>next.close());
  expect(await deliver(next,submission.id,target,async()=>{remoteAccepts++;return {messageId:5};})).toBe('uncertain');
  expect(remoteAccepts).toBe(mode==='sending-at-crash'?0:1);
});

it('keeps legacy citation anchors and records a distinct native locator with immutable entry identity',async()=>{
  const dir=await directory(),path=join(dir,'legacy.jsonl'),timestamp='2026-01-01T00:00:00.000Z';
  await writeFile(path,[{type:'session',version:3,id:'legacy-session',cwd:dir,timestamp},{type:'message',id:'legacy-entry',parentId:null,timestamp,message:{role:'user',content:'Synthetic old evidence',timestamp:Date.parse(timestamp)}}].map(e=>JSON.stringify(e)).join('\n')+'\n');
  const legacyLocator={sessionId:'legacy-session',entryId:'legacy-entry',timestamp};
  const legacyStore={backend:'jsonl',instanceId:'fixture',storeId:'archive',principal:'test-principal',path};
  const legacy=await resolveLocator(legacyLocator,'test-principal',[legacyStore]);
  expect(legacy).toMatchObject({sessionId:'legacy-session',entryId:'legacy-entry',timestamp,text:'Synthetic old evidence'});
  const p=await openPilot(join(dir,'db'));const submitted=await p.root.submit({type:'input',content:'Synthetic native evidence',entry:{kind:'bridge.source',data:{originalAt:Date.parse(timestamp)}}},context);await submitted.wait(context);
  const native=(await p.root.entries({},100,undefined,context)).items.find(e=>e.kind==='bridge.source')!;
  const locator={backend:'durable',instanceId:'fixture',storeId:'main',conversationId:p.root.id,entryId:native.id,timestamp:new Date(native.model![0]!.timestamp).toISOString()};await p.close();
  const next=await openPilot(join(dir,'db'));cleanups.push(()=>next.close());
  const stores=[legacyStore,{backend:'durable',instanceId:'fixture',storeId:'main',principal:'test-principal',p:next}];
  expect((await resolveLocator(locator,'test-principal',stores)).data).toMatchObject({originalAt:Date.parse(timestamp)});
  expect(await resolveLocator(legacyLocator,'test-principal',stores)).toMatchObject(legacyLocator);
  await expect(resolveLocator({...locator,backend:'unknown'},'test-principal',stores)).rejects.toThrow('Unknown history backend');
  await expect(resolveLocator({...locator,storeId:'foreign'},'test-principal',stores)).rejects.toThrow('unauthorized history store');
  await expect(resolveLocator(locator,'foreign-principal',stores)).rejects.toThrow('unauthorized history store');
  await expect(resolveLocator({...locator,timestamp:'1999-01-01T00:00:00.000Z'},'test-principal',stores)).rejects.toThrow('anchor missing');
  expect(await readFile(path,'utf8')).toContain('legacy-entry'); // no legacy conversion or rewrites
});

it('applies the existing canonical profile filter before imports, including recovery and child selection',async()=>{
  const dir=await directory();await mkdir(join(dir,'.pi'));
  await writeFile(join(dir,'instructions.md'),'SYNTHETIC');
  await writeFile(join(dir,'allowed.mjs'),'export default {name:"allowed"};');
  await writeFile(join(dir,'forbidden.mjs'),'throw new Error("UNSELECTED_MODULE_EXECUTED");');
  const manifest={version:1,resources:{extensions:[{id:'allowed',path:'allowed.mjs',enabled:true},{id:'forbidden',path:'forbidden.mjs',enabled:true}],skills:[],instructions:[{id:'instructions',path:'instructions.md',enabled:true}]},profiles:[{id:'restricted',extensions:['allowed'],skills:[],instructions:'instructions'}]};
  await writeFile(join(dir,'.pi/capabilities.json'),JSON.stringify(manifest));
  async function selectedRegistry(){const selected=await loadCapabilityProfile(dir,'restricted');const registry=createRegistry();for(const path of selected.extensionPaths)registry.install((await import(pathToFileURL(path).href)).default);return registry;}
  const p=await openPilot(join(dir,'db'),{registry:await selectedRegistry()});
  await p.root.commit(async tx=>{(await tx.doc(AgentDoc,p.root.id)).extensions=['forbidden'];},context);await p.close();
  const next=await openPilot(join(dir,'db'),{registry:await selectedRegistry()});cleanups.push(()=>next.close());
  expect((await next.root.agent(context)).tools).toEqual([]);
  const anchor=defineTask<{}, {phase:'hold'}, null>({name:'probe.anchor',version:1,initial:()=>({phase:'hold'}),phases:{hold:async()=>{}},abort:async()=>{}});
  const childId=await next.root.commit(async tx=>{const taskId=await tx.createTask(anchor,{}, {ownership:{kind:'conversation'},conversationId:next.root.id});return (await tx.createConversation({ownership:{kind:'task',taskId}})).id;},context);
  const child=await next.harness.conversation(childId,context);expect((await child!.agent(context)).tools).toEqual([]);
  await rm(join(dir,'allowed.mjs'));const outside=join(await directory(),'escape.mjs');await writeFile(outside,'throw new Error("ESCAPE");');await symlink(outside,join(dir,'allowed.mjs'));
  await expect(loadCapabilityProfile(dir,'restricted')).rejects.toThrow('outside the immutable release');
});
