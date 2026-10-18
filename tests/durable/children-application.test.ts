import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { loadNativeConfig } from '../../src/durable/config.js';
import { loadCapabilityProfile } from '../../src/capabilities.js';
import { NativeChildren } from '../../src/durable/children.js';
import { ChildArtifacts } from '../../src/durable/child-artifacts.js';
import { context } from '../../src/durable/ingress.js';
import { cleanup, setup } from './parity-application-fixture.js';

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
test('child selection is additive and requires the same explicit schedule and private integration configuration',async()=>{
 const s=await setup('durable-jobs-children-test');
 const {historyDir,inboxPath,runtimeMetadataPath,...raw}=s.config,path=join(s.directory,'instance.json');
 await writeFile(path,JSON.stringify(raw),{mode:0o600});expect((await loadNativeConfig(path)).capabilityProfile).toBe('durable-jobs-children-test');
 await writeFile(path,JSON.stringify({...raw,coordinator:{...raw.coordinator,schedules:undefined}}));await expect(loadNativeConfig(path)).rejects.toThrow('schedules');
 const manifest=JSON.parse(await readFile(join(s.config.resourceRoot,'.pi/capabilities.json'),'utf8'));
 const old=manifest.profiles.find((p:any)=>p.id==='durable-jobs-schedules-test'),selected=manifest.profiles.find((p:any)=>p.id==='durable-jobs-children-test');
 expect(selected.extensions).toEqual([...old.extensions,'native-background-children']);expect(selected.skills).toEqual(old.skills);
 expect(manifest.profiles.filter((p:any)=>p.extensions.includes('native-background-children')).map((p:any)=>p.id)).toEqual(['durable-jobs-children-test','durable-personal-isaac','durable-personal-emma','durable-household-shared','durable-builder']);
 expect((await loadCapabilityProfile(s.config.resourceRoot,selected.id)).extensionPaths.some(p=>p.endsWith('background-children.mjs'))).toBe(true);
});

test('actual application runs the selected child bundle and emits only one final proactive synthesis',async()=>{
 const s=await setup('durable-jobs-children-test'),artifacts=new ChildArtifacts(s.stateDir),gate=Promise.withResolvers<void>();
 const active=new Set<string>();
 const supervisor={active:(id:string)=>active.has(id),close:async()=>{},run:async(batchId:string,jobId:string,control:any)=>{
  active.add(batchId);try{await gate.promise;control.signal.throwIfAborted();const m=await artifacts.readManifest(batchId,jobId);const o={version:1 as const,batchId,jobId,launchId:m.launchId,status:'completed' as const,finishedAt:Date.now(),output:'SYNTHETIC_CHILD_REPORT'};await artifacts.writeOutcome(o);return o;}finally{active.delete(batchId);}
 }};
 const app=await s.open([
  answer(fauxToolCall('background_subagents',{operation:'launch',tasks:[{task:'Read the synthetic fixture',model:'openai-codex/faux-1',thinking:'off'}]}),{stopReason:'toolUse'}),answer('LAUNCHED'),
  (request:any)=>{expect(JSON.stringify(request.messages)).toContain('SYNTHETIC_CHILD_REPORT');return answer('SYNTHESIS_ONLY');},
 ],false,{childSupervisor:supervisor});
 await s.accept('Research the explicitly listed task');await vi.waitFor(()=>expect(s.finals).toEqual(['LAUNCHED']));
 expect(s.requests[0].messages[0].toolsAdded.map((t:any)=>t.name)).toContain('background_subagents');
 const b=Object.values((await app.host.runtime.harness.snapshot(NativeChildren,app.host.runtime.root.id,context))!.batches)[0]!;
 expect(b.jobs).toHaveLength(1);s.previews.length=0;gate.resolve();
 await vi.waitFor(()=>expect(s.finals).toEqual(['LAUNCHED','SYNTHESIS_ONLY']),{timeout:6000});
 expect(s.previews).toEqual([]);expect(s.fatal).toEqual([]);
 await app.host.reconcile();expect(s.finals).toHaveLength(2);
});
