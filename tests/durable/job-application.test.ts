import { mkdir,readFile,readdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach,expect,test,vi } from 'vitest';
import { fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { enqueueJobHandoff } from '../../src/job-handoff.js';
import { Bindings,context } from '../../src/durable/ingress.js';
import { loadNativeConfig } from '../../src/durable/config.js';
import { cleanup,setup,fictionalWebAuth } from './parity-application-fixture.js';
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function publish(s:Awaited<ReturnType<typeof setup>>,eventId='one',prompt='Synthetic scheduled prompt'){
 const coordinatorStateDir=join(s.directory,'coordinator');await mkdir(coordinatorStateDir,{recursive:true,mode:0o700});
 return enqueueJobHandoff({stateRoot:s.directory,coordinatorStateDir,eventId,jobId:'reminder',jobType:'at',target:'test',prompt,now:()=>new Date('2024-01-02T03:04:05.000Z')});
}
async function sources(s:Awaited<ReturnType<typeof setup>>){const h=s.app()!.host;return (await h.runtime.harness.snapshot(Bindings,h.runtime.root.id,context))!;}

test('the actual recipient application admits a legacy coordinator handoff, preserves its source time, and sends only one final',async()=>{
 const s=await setup('durable-jobs-test');const {dispatchId}=await publish(s);
 await s.open([fauxAssistantMessage('SCHEDULED')]);
 await vi.waitFor(()=>expect(s.finals).toEqual(['SCHEDULED']));
 await s.app()!.host.reconcile();
 const admitted=JSON.parse(await readFile(join(s.config.stateDir,'job-handoffs','completed',`${dispatchId}.json`),'utf8'));
 expect(admitted.dispatchId).toBe(dispatchId);expect(admitted.createdAt).toBe('2024-01-02T03:04:05.000Z');
 const state=await sources(s);const bindings=Object.values(state.sources);expect(bindings).toHaveLength(1);
 expect(bindings[0]).toMatchObject({proactive:true,chatId:42,originalAt:Date.parse(admitted.createdAt),envelope:{job:{dispatchId,jobId:'reminder',jobType:'at'},messageIds:[]}});
 expect(state.lastHumanAt).toBe(0);expect(s.previews).toEqual([]);expect(s.fatal).toEqual([]);
 expect(await s.app()!.inspectJobs()).toMatchObject({files:{completed:1},admissions:{admitted:1},runs:{done:1},unsafeTree:false});
 await s.close();await s.open([fauxAssistantMessage('SHOULD NOT RUN')]);await s.app()!.host.reconcile();
 expect(s.finals).toEqual(['SCHEDULED']);expect(s.requests).toHaveLength(1);
});

test('a busy human run admits scheduled follow-up early and the occurrence never advances the human-idle clock',async()=>{
 const s=await setup('durable-jobs-test');const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 await s.open([async()=>{started.resolve();await release.promise;return fauxAssistantMessage('HUMAN');},fauxAssistantMessage('JOB')]);
 await s.accept('Human request');await started.promise;
 const before=await sources(s);const {dispatchId}=await publish(s);
 await s.app()!.host.reconcile();
 expect(await readdir(join(s.config.stateDir,'job-handoffs','completed'))).toContain(`${dispatchId}.json`);
 const during=await sources(s);expect(during.epoch).toBe(before.epoch);expect(during.lastHumanAt).toBe(before.lastHumanAt);
 expect(s.finals).toEqual([]);expect(Object.values(during.sources).filter(b=>b.proactive)).toHaveLength(1);
 expect(await s.app()!.inspectJobs()).toMatchObject({admissions:{admitted:1},runs:{pending:1}});
 release.resolve();await vi.waitFor(()=>expect(s.finals).toEqual(['HUMAN','JOB']));
 expect(s.previews.every(text=>!text.includes('JOB'))).toBe(true);expect(s.fatal).toEqual([]);
});

test('proactive NO_REPLY never reaches previews or final delivery and human input remains visible',async()=>{
 const s=await setup('durable-jobs-test');await publish(s);
 await s.open([fauxAssistantMessage('NO_REPLY'),fauxAssistantMessage('HUMAN REPLY')]);
 await vi.waitFor(async()=>{const b=Object.values((await sources(s)).sources)[0];expect(b?.deliveryComplete).toBe(true);});
 expect(s.finals).toEqual([]);expect(s.previews).toEqual([]);
 await s.accept('A human message');await vi.waitFor(()=>expect(s.finals).toEqual(['HUMAN REPLY']));
 expect(s.previews.every(text=>!text.includes('NO_REPLY'))).toBe(true);
});

test('job selection is explicit in configuration and older profiles leave recipient files untouched',async()=>{
 const s=await setup('durable-jobs-test');
 const {historyDir,inboxPath,runtimeMetadataPath,...raw}=s.config;
 const path=join(s.directory,'instance.json');await writeFile(path,JSON.stringify(raw),{mode:0o600});
 await expect(loadNativeConfig(path)).resolves.toMatchObject({capabilityProfile:'durable-jobs-test',jobsRole:'recipient'});
 for(const changed of [{jobsRole:'disabled'},{jobsRole:'coordinator'},{principal:'emma'}]){await writeFile(path,JSON.stringify({...raw,...changed}),{mode:0o600});await expect(loadNativeConfig(path)).rejects.toThrow();}
 s.config.capabilityProfile='durable-parity-test';s.config.jobsRole='disabled';const {dispatchId}=await publish(s);
 await s.open([]);await s.app()!.host.reconcile();
 expect(await readdir(join(s.config.stateDir,'job-handoffs','pending'))).toEqual([`${dispatchId}.json`]);expect(s.requests).toEqual([]);
 expect(Object.keys((await sources(s))?.sources??{})).toEqual([]);expect(s.fatal).toEqual([]);
});

test('a scheduled follow-up waits through a human tool round and never previews NO_REPLY',async()=>{
 const s=await setup('durable-jobs-test');
 const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 await s.open([
  fauxAssistantMessage(fauxToolCall('web_run',{search_query:[{q:'Synthetic held tool'}]}),{stopReason:'toolUse'}),
  fauxAssistantMessage('HUMAN AFTER TOOL'),
  fauxAssistantMessage('NO_REPLY'),
  fauxAssistantMessage('LATER HUMAN'),
 ],false,{webRunFetch:async()=>{
  started.resolve();await release.promise;
  return new Response('{"output_text":"Synthetic result","search_results":[]}');
 }},fictionalWebAuth);
 try{
  await s.accept('Human before tool');await started.promise;
  await publish(s,'post-tools','Scheduled post-tools prompt');await s.app()!.host.reconcile();
  expect(await s.app()!.inspectJobs()).toMatchObject({admissions:{admitted:1},runs:{pending:1}});
  release.resolve();
  await vi.waitFor(async()=>{
   const bindings=Object.values((await sources(s)).sources);
   expect(bindings).toHaveLength(2);expect(bindings.every(b=>b.deliveryComplete)).toBe(true);
  });
  // Pinned 1.3.0 admits follow-ups at final boundaries; only steering joins
  // an existing run after tools. Keep this protocol distinction explicit.
  expect(s.requests).toHaveLength(3);
  expect(JSON.stringify(s.requests[1].messages)).not.toContain('Scheduled post-tools prompt');
  expect(JSON.stringify(s.requests[2].messages)).toContain('Scheduled post-tools prompt');
  expect(s.finals).toEqual(['HUMAN AFTER TOOL']);
  expect(s.previews.some(text=>text.includes('NO_REPLY'))).toBe(false);
  await s.accept('Later human request');await vi.waitFor(()=>expect(s.finals).toContain('LATER HUMAN'));
  expect(s.fatal).toEqual([]);
 }finally{release.resolve();}
});
