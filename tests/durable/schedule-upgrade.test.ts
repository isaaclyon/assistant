import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { loadNativeConfig } from '../../src/durable/config.js';
import { assertScheduleOnlyUpgrade } from '../../src/durable/schedule-upgrade.js';
import { createNativeApplication } from '../../src/durable/application.js';
import { HostState } from '../../src/durable/host.js';
import { context } from '../../src/durable/ingress.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'schedule-upgrade-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const oldSha='a'.repeat(40),newSha='b'.repeat(40),oldRelease=join(root,oldSha),newRelease=join(root,newSha),stateDir=join(root,'state'),workspaceCwd=join(root,'workspace');
 for(const path of [join(oldRelease,'.pi'),stateDir,workspaceCwd])await mkdir(path,{recursive:true,mode:0o700});
 await writeFile(join(oldRelease,'.pi/instructions.md'),'OLD_INSTRUCTIONS');
 await writeFile(join(oldRelease,'.pi/capabilities.json'),JSON.stringify({version:1,resources:{extensions:[],skills:[],instructions:[{id:'test',path:'.pi/instructions.md',enabled:true}]},profiles:[{id:'durable-tools-test',extensions:[],skills:[],instructions:'test'}]}));
 await cp(oldRelease,newRelease,{recursive:true});await writeFile(join(newRelease,'.pi/instructions.md'),'NEW_INSTRUCTIONS');
 const prior={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:oldSha,resourceRoot:oldRelease,stateDir,workspaceCwd,capabilityProfile:'durable-tools-test',account:'test',credentialPath:join(root,'auth'),settingsPath:join(root,'settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(root,'broker.sock'),botId:123,allowedUserId:42},memory:{vaultRoot:join(root,'vault'),gitAutocommit:false,legacySessionRoots:[],timeZone:'UTC',recall:'off',semantic:'off'}};
 const priorPath=join(root,'prior.json');await writeFile(priorPath,JSON.stringify(prior),{mode:0o600});
 const keyFile=join(root,'key');await writeFile(keyFile,'a'.repeat(64),{mode:0o600});
 const next={...prior,releaseSha:newSha,resourceRoot:newRelease,scheduleClient:{socketPath:join(root,'control.sock'),serverUid:process.getuid!(),keyFile},scheduleUpgradeFrom:{configPath:priorPath,sha256:hash(prior)}};
 const nextPath=join(root,'next.json');const save=async(value:unknown)=>writeFile(nextPath,JSON.stringify(value),{mode:0o600});await save(next);
 return {root,prior,next,priorPath,nextPath,save};
}
test('only explicit pinned schedule-management changes are permitted',async()=>{
 const f=await fixture();expect((await loadNativeConfig(f.nextPath)).scheduleClient).toEqual(f.next.scheduleClient);
 for(const patch of [{account:'other'},{jobsRole:'coordinator'},{transport:{...f.next.transport,allowedUserId:43}},{workspaceCwd:f.root},{memory:{...f.next.memory,recall:'jev'}},{coordinator:{targets:['other']}},{extra:'unknown'}])expect(()=>assertScheduleOnlyUpgrade({...f.next,...patch},f.prior)).toThrow();
 await f.save({...f.next,scheduleUpgradeFrom:{...f.next.scheduleUpgradeFrom,sha256:'c'.repeat(64)}});await expect(loadNativeConfig(f.nextPath)).rejects.toThrow(/digest/);
 await f.save({...f.next,instructionUpgradeFrom:f.prior.releaseSha});await expect(loadNativeConfig(f.nextPath)).rejects.toThrow(/one native upgrade/);
 await f.save(f.next);await chmod(f.priorPath,0o644);await expect(loadNativeConfig(f.nextPath)).rejects.toThrow(/Unsafe/);
});
test('coordinator control may change but recipient grants and checker selection may not',()=>{
 const previous={releaseSha:'a'.repeat(40),resourceRoot:'/releases/'+ 'a'.repeat(40),coordinator:{scope:'self',targets:['personal'],schedules:{checkerIds:[]}}};
 const next={...previous,releaseSha:'b'.repeat(40),resourceRoot:'/releases/'+ 'b'.repeat(40),coordinator:{...previous.coordinator,control:{socketPath:'/run/control.sock',grants:[]}}};
 expect(()=>assertScheduleOnlyUpgrade(next,previous)).not.toThrow();
 expect(()=>assertScheduleOnlyUpgrade({...next,coordinator:{...next.coordinator,targets:['personal','builder']}},previous)).toThrow();
 expect(()=>assertScheduleOnlyUpgrade({...next,coordinator:{...next.coordinator,schedules:{checkerIds:['gmail-inbox']}}},previous)).toThrow();
});
test.each([1,2])('production composition preserves history through a pinned scheduling upgrade from schema %s',async schema=>{
 const f=await fixture();const prior=await loadNativeConfig(f.priorPath),next=await loadNativeConfig(f.nextPath);
 const requests:unknown[]=[],sent:string[]=[];let hooks!:NativeTelegramHooks;
 const transport={start:async(value:NativeTelegramHooks)=>{hooks=value;return 'ready' as const;},stop:async()=>{},deliver:async(_target:unknown,text:string)=>{sent.push(text);return 100+sent.length;},present:async()=>200,edit:async()=>{},answerCallback:async()=>true};
 const provider=()=>{const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});faux.setResponses([request=>{requests.push(structuredClone(request));return fauxAssistantMessage('DONE');}]);const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();return {models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off' as const,close(){}};};
 let app:Awaited<ReturnType<typeof createNativeApplication>>|undefined;cleanup.push(async()=>{await app?.close();});
 const opts=()=>({provider:provider(),transport,onFatal:()=>{},onTransportFailure:()=>{}});
 app=await createNativeApplication(prior,opts());await app.start();
 const event={update_id:1,message:{message_id:11,date:1700000000,from:{id:42},chat:{id:42,type:'private'},text:'QUESTION_BEFORE'}};
 await hooks.accept(event);await vi.waitFor(()=>expect(sent).toHaveLength(1));await app.host.reconcile();
 const rootId=app.host.runtime.root.id;
 if(schema===1){
  const registry=hash({profileId:prior.capabilityProfile,extensionNames:[],bundleVersions:[],toolNames:[],toolSignatures:[],instructions:'OLD_INSTRUCTIONS',skills:[]});
  const registrySignature=hash({registry,instance:prior.instanceId,principal:prior.principal,bot:123,actor:42,memory:prior.memory});
  await app.host.runtime.root.commit(async tx=>{const state=await tx.doc(HostState,rootId);state.compatibility={runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:prior.capabilityProfile,registrySignature};},context);
 }
 await app.close();app=undefined;
 await expect(createNativeApplication({...next,scheduleUpgradeFrom:undefined},opts())).rejects.toThrow(/Incompatible/);
 app=await createNativeApplication(next,opts());expect((await app.host.inspect()).compatibility?.releaseSchema).toBe(schema);
 await app.start();expect(app.host.runtime.root.id).toBe(rootId);expect((await app.host.inspect()).compatibility?.releaseSchema).toBe(2);
 await hooks.accept(event);await app.host.reconcile();expect(sent).toHaveLength(1);
 await hooks.accept({...event,update_id:2,message:{...event.message,message_id:12,text:'QUESTION_AFTER'}});
 await vi.waitFor(()=>expect(sent).toHaveLength(2));
 expect(JSON.stringify(requests.at(-1))).toContain('QUESTION_BEFORE');expect(JSON.stringify(requests.at(-1))).toContain('NEW_INSTRUCTIONS');
 await app.close();app=undefined;
 app=await createNativeApplication({...next,scheduleUpgradeFrom:undefined},opts());await app.start();expect(app.host.runtime.root.id).toBe(rootId);
});
