import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { loadNativeConfig } from '../../src/durable/config.js';
import { assertMediaOnlyUpgrade } from '../../src/durable/media-upgrade.js';
import { cleanup, setup } from './parity-application-fixture.js';

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const oldSha='a'.repeat(40),newSha='b'.repeat(40),socketPath='/run/media-gateway/gateway.sock';

test('only the media bundle and its configuration may arrive with a pinned predecessor',()=>{
 const previous={releaseSha:oldSha,resourceRoot:'/releases/'+oldSha,account:'test',coordinator:{scope:'self',targets:['isaac']}};
 const next={...previous,releaseSha:newSha,resourceRoot:'/releases/'+newSha,mediaStack:{socketPath}};
 expect(()=>assertMediaOnlyUpgrade(next,previous)).not.toThrow();
 expect(()=>assertMediaOnlyUpgrade({...next,mediaStack:undefined},previous)).not.toThrow();
 for(const patch of [{account:'other'},{coordinator:{scope:'self',targets:['isaac','builder']}},{extra:1},{releaseSha:oldSha},{resourceRoot:'/elsewhere/'+newSha}])
  expect(()=>assertMediaOnlyUpgrade({...next,...patch},previous)).toThrow();
 expect(()=>assertMediaOnlyUpgrade(next,{...previous,mediaStack:{socketPath}})).toThrow(/without media/);
});

test('a store created before the media bundle keeps its history through the pinned upgrade',async()=>{
 const s=await setup('durable-builder');
 Object.assign(s.config,{principal:'engineering'});
 delete (s.config as any).google;delete (s.config as any).cli;s.config.browser={...s.config.browser!,credentialScope:'engineering'} as never;
 const repo=resolve(import.meta.dirname,'../..'),directory=await realpath(s.directory),releases=join(directory,'releases'),oldRoot=join(releases,oldSha),newRoot=join(releases,newSha);
 for(const root of [oldRoot,newRoot]){await cp(join(repo,'.pi'),join(root,'.pi'),{recursive:true});await mkdir(join(root,'.pi/prompts'),{recursive:true});}
 const manifestPath=join(oldRoot,'.pi/capabilities.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 const profile=manifest.profiles.find((p:any)=>p.id==='durable-builder');
 profile.extensions=profile.extensions.filter((id:string)=>id!=='native-media-stack');
 await writeFile(manifestPath,JSON.stringify(manifest));
 const {historyDir,inboxPath,runtimeMetadataPath,...raw}={...s.config,releaseSha:oldSha,resourceRoot:oldRoot} as any;
 const priorPath=join(directory,'prior.json');await writeFile(priorPath,JSON.stringify(raw),{mode:0o600});
 const sha256=createHash('sha256').update(await readFile(priorPath)).digest('hex');
 Object.assign(s.config,await loadNativeConfig(priorPath));
 await s.open([answer('BEFORE')]);await s.accept('First');await vi.waitFor(()=>expect(s.finals).toEqual(['BEFORE']));
 const rootId=s.app()!.host.runtime.root.id;await s.close();

 const next={...raw,releaseSha:newSha,resourceRoot:newRoot,mediaStack:{socketPath}},nextPath=join(directory,'next.json');
 const select=async(selector?:unknown)=>{await writeFile(nextPath,JSON.stringify({...next,...(selector?{mediaUpgradeFrom:selector}:{})}),{mode:0o600});return loadNativeConfig(nextPath);};

 await expect(select({configPath:priorPath,sha256:'c'.repeat(64)})).rejects.toThrow(/digest/);
 Object.assign(s.config,await select());
 await expect(s.open([answer('X')])).rejects.toThrow(/Incompatible/);
 Object.assign(s.config,await select({configPath:priorPath,sha256}));
 await s.open([answer('AFTER')]);
 expect(s.app()!.host.runtime.root.id).toBe(rootId);
 await s.accept('Second');await vi.waitFor(()=>expect(s.finals).toEqual(['BEFORE','AFTER']));
 expect(JSON.stringify(s.requests.at(-1))).toContain('First');
 expect(s.requests.at(-1).messages.flatMap((m:any)=>m.toolsAdded??[]).map((t:any)=>t.name)).toEqual(expect.arrayContaining(['media_stack','media_request']));
 await s.close();
 Object.assign(s.config,await select());delete (s.config as any).mediaUpgradeFrom;
 await s.open([answer('LATER')]);expect(s.app()!.host.runtime.root.id).toBe(rootId);
});

test('the selector is rejected with another native upgrade mode',async()=>{
 const s=await setup('durable-builder');
 const {historyDir,inboxPath,runtimeMetadataPath,...raw}=s.config as any,path=join(s.directory,'both.json');
 raw.principal='engineering';delete raw.google;delete raw.cli;raw.browser={...raw.browser,credentialScope:'engineering'};
 await writeFile(path,JSON.stringify({...raw,mediaUpgradeFrom:{configPath:path,sha256:'c'.repeat(64)},scheduleUpgradeFrom:{configPath:path,sha256:'c'.repeat(64)}}),{mode:0o600});
 await expect(loadNativeConfig(path)).rejects.toThrow(/one native upgrade/);
});
