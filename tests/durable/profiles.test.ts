import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { loadNativeConfig } from '../../src/durable/config.js';
import { loadCapabilityProfile } from '../../src/capabilities.js';
import { NATIVE_PROFILE_IDS, requireProfilePolicy } from '../../src/durable/profiles.js';
import { cleanup, setup } from './parity-application-fixture.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const NEW=['durable-personal-isaac','durable-personal-emma','durable-household-shared','durable-builder'];
const LEGACY_14=NATIVE_PROFILE_IDS.filter(id=>!NEW.includes(id));
const names=(s:{requests:any[]})=>s.requests[0].messages.flatMap((m:any)=>m.toolsAdded??[]).map((t:any)=>t.name).sort();

/** Writes the fixture configuration to disk and loads it through the production validator. */
async function load(profile:string,patch:(raw:any,s:Awaited<ReturnType<typeof setup>>)=>void=()=>{}) {
 const s=await setup(profile);
 const {historyDir,inboxPath,runtimeMetadataPath,...raw}=s.config as any,path=join(s.directory,`${profile}.json`);
 if(profile==='durable-personal-isaac')raw.browser={...raw.browser,credentialScope:'isaac-personal'};
 patch(raw,s);await writeFile(path,JSON.stringify(raw),{mode:0o600});
 return {s,load:()=>loadNativeConfig(path)};
}
const group={chatId:-100500,actors:{isaac:42,emma:43}};
const builderCfg=(raw:any)=>{raw.principal='engineering';raw.browser={...raw.browser,credentialScope:'engineering'};delete raw.google;delete raw.cli;raw.jobsRole='disabled';delete raw.coordinator;};

test('policy table keeps the 14 existing test profiles and adds the four production profiles',()=>{
 expect(LEGACY_14).toHaveLength(14);expect(NATIVE_PROFILE_IDS).toHaveLength(18);
 expect(requireProfilePolicy('durable-jobs-children-test').principals).toEqual(['isaac']);
 expect(requireProfilePolicy('durable-builder')).toMatchObject({memory:'history',places:false,google:false,commands:['deploy']});
 expect(NATIVE_PROFILE_IDS.filter(id=>requireProfilePolicy(id).commands?.includes('deploy'))).toEqual(['durable-builder']);
 expect(NATIVE_PROFILE_IDS.filter(id=>requireProfilePolicy(id).places)).not.toContain('durable-personal-emma');
 expect(NATIVE_PROFILE_IDS.filter(id=>requireProfilePolicy(id).surface==='group')).toEqual(['durable-household-shared']);
});

test('manifest selections mirror the legacy profiles with native replacements',async()=>{
 const root=(await setup('durable-foundation-test')).config.resourceRoot;
 const manifest=JSON.parse(await readFile(join(root,'.pi/capabilities.json'),'utf8'));
 const get=(id:string)=>manifest.profiles.find((p:any)=>p.id===id);
 const legacy=(id:string)=>get(id).skills.slice().sort();
 const skills=(id:string)=>get(id).skills.slice().sort();
 expect(skills('durable-personal-emma')).toEqual(legacy('personal-emma'));
 expect(skills('durable-household-shared')).toEqual(legacy('household-shared'));
 expect(skills('durable-builder').filter((id:string)=>id!=='manage-media')).toEqual(legacy('builder'));
 expect(skills('durable-personal-isaac').filter((id:string)=>id!=='manage-media')).toEqual(skills('durable-jobs-children-test'));
 const ext=(id:string)=>new Set<string>(get(id).extensions);
 expect(['durable-personal-isaac','durable-builder'].map(id=>[ext(id).has('native-media-stack'),skills(id).includes('manage-media')])).toEqual([[true,true],[true,true]]);
 expect(['durable-personal-emma','durable-household-shared','durable-jobs-children-test'].some(id=>ext(id).has('native-media-stack')||skills(id).includes('manage-media'))).toBe(false);
 for(const id of NEW){expect(ext(id).has('native-background-children')).toBe(true);await loadCapabilityProfile(root,id);}
 expect(ext('durable-builder').has('native-memory')).toBe(false);expect(ext('durable-builder').has('native-core-memory')).toBe(false);
 expect(ext('durable-builder').has('native-search')).toBe(true);expect(ext('durable-builder').has('native-places')).toBe(false);
 expect(ext('durable-personal-emma').has('native-private-browser')).toBe(true);expect(ext('durable-personal-emma').has('native-places')).toBe(false);
 expect(ext('durable-household-shared').has('native-private-browser')).toBe(false);
 expect(ext('durable-personal-isaac').has('native-places')).toBe(true);
 for(const id of ['personal-isaac','personal-emma','household-shared','builder'])expect(ext(id).has('native-memory')).toBe(false);
});

test('configuration accepts the four profiles and rejects legacy resource profile names',async()=>{
 const c=await load('durable-personal-isaac');await expect(c.load()).resolves.toMatchObject({capabilityProfile:'durable-personal-isaac'});
 for(const legacy of ['personal-isaac','personal-emma','household-shared','builder']){
  const bad=await load('durable-personal-isaac',raw=>{raw.capabilityProfile=legacy;});await expect(bad.load()).rejects.toThrow(/profile/);
 }
 const emma=await load('durable-personal-emma',raw=>{raw.principal='emma';raw.browser={...raw.browser,credentialScope:'emma-personal'};delete raw.google;raw.jobsRole='disabled';delete raw.coordinator;});
 await expect(emma.load()).resolves.toMatchObject({principal:'emma'});
 const wrong=await load('durable-personal-emma',raw=>{raw.principal='isaac';});await expect(wrong.load()).rejects.toThrow();
 const b=await load('durable-builder',builderCfg);await expect(b.load()).resolves.toMatchObject({principal:'engineering'});
 const noPrivate=await load('durable-builder',raw=>{builderCfg(raw);raw.principal='isaac';});await expect(noPrivate.load()).rejects.toThrow();
 await expect((await load('durable-chat-memory-test',raw=>{delete raw.google;delete raw.browser;delete raw.cli;delete raw.coordinator;raw.jobsRole='disabled';})).load()).resolves.toMatchObject({capabilityProfile:'durable-chat-memory-test'});
});

test('media stack configuration is an absolute socket path accepted only by profiles that enable it',async()=>{
 const ok=await load('durable-personal-isaac',raw=>{raw.mediaStack={socketPath:'/run/media-gateway/gateway.sock'};});
 await expect(ok.load()).resolves.toMatchObject({mediaStack:{socketPath:'/run/media-gateway/gateway.sock'}});
 await expect((await load('durable-personal-isaac')).load()).resolves.not.toHaveProperty('mediaStack');
 for(const mediaStack of [{socketPath:'relative.sock'},{socketPath:'/run/m.sock',extra:1},'x']){
  await expect((await load('durable-personal-isaac',raw=>{raw.mediaStack=mediaStack;})).load()).rejects.toThrow();
 }
 await expect((await load('durable-places-test',raw=>{raw.mediaStack={socketPath:'/run/m.sock'};})).load()).rejects.toThrow(/Media stack/);
 expect(NATIVE_PROFILE_IDS.filter(id=>requireProfilePolicy(id).mediaStack)).toEqual(['durable-personal-isaac','durable-builder']);
});

test('household configuration needs an exact group with two distinct actors and no group on private profiles',async()=>{
 const base=(raw:any)=>{raw.principal='household';raw.jobsRole='disabled';delete raw.coordinator;delete raw.google;delete raw.browser;raw.group=group;raw.transport={mode:'ordinary',profile:'synthetic-profile',configPath:join(raw.workspaceCwd,'..','agent','telegram.json'),locksPath:join(raw.workspaceCwd,'..','agent','locks.json'),botId:123,allowedUserId:42};};
 await expect((await load('durable-household-shared',base)).load()).resolves.toMatchObject({principal:'household',group:{chatId:-100500,actors:[{id:42,label:'Isaac'},{id:43,label:'Emma'}]}});
 await expect((await load('durable-household-shared',raw=>{base(raw);delete raw.group;})).load()).rejects.toThrow();
 await expect((await load('durable-household-shared',raw=>{base(raw);raw.group={chatId:-100500,actors:{isaac:42,emma:42}};})).load()).rejects.toThrow();
 await expect((await load('durable-household-shared',raw=>{base(raw);raw.group={chatId:100500,actors:{isaac:42,emma:43}};})).load()).rejects.toThrow();
 await expect((await load('durable-household-shared',raw=>{base(raw);raw.group={chatId:-100500,actors:{isaac:44,emma:43}};})).load()).rejects.toThrow(/pairing|actor/);
 await expect((await load('durable-personal-isaac',raw=>{raw.group=group;})).load()).rejects.toThrow();
 await expect((await load('durable-household-shared',raw=>{base(raw);raw.transport={mode:'broker',socketPath:'/unused.sock',botId:123,allowedUserId:42};})).load()).rejects.toThrow(/private-only/);
});

test('jobs role is explicit configuration: coordinator needs coordinator settings',async()=>{
 await expect((await load('durable-personal-isaac',raw=>{raw.jobsRole='recipient';delete raw.coordinator;})).load()).resolves.toMatchObject({jobsRole:'recipient'});
 await expect((await load('durable-personal-isaac',raw=>{raw.jobsRole='coordinator';delete raw.coordinator;})).load()).rejects.toThrow();
 await expect((await load('durable-personal-isaac',raw=>{raw.jobsRole='disabled';delete raw.coordinator;})).load()).resolves.toMatchObject({jobsRole:'disabled'});
});

async function builder() {
 const s=await setup('durable-builder');Object.assign(s.config,{principal:'engineering'});
 delete (s.config as any).google;delete (s.config as any).cli;s.config.browser={...s.config.browser!,credentialScope:'engineering'} as never;
 await mkdir(join(s.config.resourceRoot,'.pi/prompts'),{recursive:true});
 return s;
}
test('builder runs session search without memory or core tools and its tools authorize',async()=>{
 const s=await builder();
 await s.open([answer('BUILT')]);
 await s.accept('Check engineering status');await vi.waitFor(()=>expect(s.finals).toEqual(['BUILT']));
 const tools=names(s);
 expect(tools).toContain('assistant_session_search');expect(tools).toContain('session_context');
 expect(tools).not.toContain('assistant_memory');expect(tools).not.toContain('rank_places');
 expect(tools).not.toContain('google_workspace');
 expect(s.fatal).toEqual([]);
});
test('media tools reach the personal Isaac and builder bots only when a gateway socket is configured',async()=>{
 const socketPath='/run/media-gateway/gateway.sock';
 const isaac=await setup('durable-personal-isaac');isaac.config.browser={...isaac.config.browser!,credentialScope:'isaac-personal'} as never;
 await isaac.open([answer('NONE')]);await isaac.accept('Media?');await vi.waitFor(()=>expect(isaac.finals).toEqual(['NONE']));
 expect(names(isaac)).not.toContain('media_stack');expect(isaac.fatal).toEqual([]);await isaac.close();
 const configured=await setup('durable-personal-isaac');configured.config.browser={...configured.config.browser!,credentialScope:'isaac-personal'} as never;
 Object.assign(configured.config,{mediaStack:{socketPath}});
 await configured.open([answer('SOME')]);await configured.accept('Media?');await vi.waitFor(()=>expect(configured.finals).toEqual(['SOME']));
 expect(names(configured)).toEqual(expect.arrayContaining(['media_stack','media_request']));expect(configured.fatal).toEqual([]);await configured.close();
 const b=await builder();Object.assign(b.config,{mediaStack:{socketPath}});
 await b.open([answer('BUILT')]);await b.accept('Media?');await vi.waitFor(()=>expect(b.finals).toEqual(['BUILT']));
 expect(names(b)).toEqual(expect.arrayContaining(['media_stack','media_request']));expect(b.fatal).toEqual([]);
});
test('/deploy is a builder command that enqueues the deploy prompt as normal input',async()=>{
 const s=await builder();
 await s.open([answer('DEPLOY_STARTED')]);
 await s.accept('/deploy');await vi.waitFor(()=>expect(s.finals).toEqual(['DEPLOY_STARTED']));
 const prompt=(await readFile(join(s.config.resourceRoot,'.pi/prompts/deploy.md'),'utf8')).replace(/^---[\s\S]*?---\n/,'').trim();
 expect(JSON.stringify(s.requests[0].messages)).toContain(prompt.slice(0,40).replace(/\n.*/s,'').replace(/"/g,'\\"').slice(0,20));
 await s.close();
 const isaac=await setup('durable-personal-isaac');isaac.config.browser={...isaac.config.browser!,credentialScope:'isaac-personal'} as never;await isaac.open();
 await isaac.accept('/deploy');await vi.waitFor(()=>expect(isaac.presented.concat(isaac.finals).length).toBeGreaterThan(0));
 expect(isaac.requests).toHaveLength(0);
});
test('Emma has private browser tools; places and Google stay Isaac only',async()=>{
 const e=await setup('durable-personal-emma');Object.assign(e.config,{principal:'emma'});delete (e.config as any).google;
 e.config.browser={...e.config.browser!,credentialScope:'emma-personal'} as never;
 await e.open([answer('EMMA')]);await e.accept('hello');await vi.waitFor(()=>expect(e.finals).toEqual(['EMMA']));
 expect(names(e)).toContain('private_browser_login');expect(names(e)).not.toContain('rank_places');expect(names(e)).not.toContain('google_workspace');
 await e.close();
 const i=await setup('durable-personal-isaac');i.config.browser={...i.config.browser!,credentialScope:'isaac-personal'} as never;await i.open([answer('ISAAC')]);await i.accept('hello');await vi.waitFor(()=>expect(i.finals).toEqual(['ISAAC']));
 expect(names(i)).toContain('rank_places');expect(names(i)).toContain('google_workspace');
});

async function household() {
 const s=await setup('durable-household-shared');
 Object.assign(s.config,{principal:'household',group:{chatId:-100500,actors:[{id:42,label:'Isaac'},{id:43,label:'Emma'}]},jobsRole:'disabled'});
 delete (s.config as any).google;delete (s.config as any).browser;delete (s.config as any).coordinator;
 let hooks!:NativeTelegramHooks,next=500;const delivered:Array<{chat:number;text:string}>=[],shown:any[]=[],edits:any[]=[];
 const raw={start:async(h:NativeTelegramHooks)=>{hooks=h;return 'ready' as const;},stop:async()=>{},deliver:async(t:any,text:string)=>{delivered.push({chat:t.chatId,text});return ++next;},preview:async()=>{},present:async(t:any,value:any)=>{shown.push({chat:t.chatId,...value});return ++next;},edit:async(_t:any,id:number,value:any)=>{edits.push({id,...value});},answerCallback:async()=>true};
 let id=1000;
 const msg=(text:string,from=42,chat:any={id:-100500,type:'supergroup'},extra:any={})=>hooks.accept({update_id:++id,message:{message_id:id*2,date:1700000000,from:{id:from},chat,text,...extra}} as never);
 const press=(messageId:number,data:string,from=42)=>hooks.accept({update_id:++id,callback_query:{id:`cb${id}`,data,from:{id:from},message:{message_id:messageId,chat:{id:-100500,type:'supergroup'}}}} as never);
 return {s,msg,press,delivered,shown,edits,raw};
}
test('household group admits only the two actors in the exact chat and attributes each message',async()=>{
 const h=await household();
 await h.s.open([answer('ONE'),answer('TWO')],false,{transport:h.raw as never});
 await h.msg('stranger',99);await h.msg('wrong chat',42,{id:-999,type:'supergroup'});await h.msg('private',42,{id:42,type:'private'});
 await h.msg('topic',42,{id:-100500,type:'supergroup',is_forum:true},{message_thread_id:7,is_topic_message:true});
 expect(h.s.requests).toHaveLength(0);
 await h.msg('plan dinner');await vi.waitFor(()=>expect(h.delivered.map(d=>d.text)).toContain('ONE'));
 await h.msg('and drinks',43);await vi.waitFor(()=>expect(h.delivered.map(d=>d.text)).toContain('TWO'));
 expect(JSON.stringify(h.s.requests[0].messages)).toContain('[telegram|actor:Isaac] plan dinner');
 expect(JSON.stringify(h.s.requests[1].messages)).toContain('[telegram|actor:Emma] and drinks');
 expect(h.delivered.every(d=>d.chat===-100500)).toBe(true);
 const tools=names(h.s);expect(tools).not.toContain('private_browser_login');expect(tools).not.toContain('rank_places');
 expect(h.s.fatal).toEqual([]);
});
const key=(shown:any)=>String(shown.buttons[0][0].callback).split(':')[2]!;
test('group /new asks the requester to confirm and consumes the confirmation once',async()=>{
 const h=await household();
 await h.s.open([answer('X')],false,{transport:h.raw as never});
 await h.msg('/new');await vi.waitFor(()=>expect(h.shown).toHaveLength(1));
 expect(h.shown[0].chat).toBe(-100500);const k=key(h.shown[0]);
 await h.press(501,`ng:a:${k}`,43);               // other actor
 await h.press(999,`ng:a:${k}`,42);               // other message
 expect(h.edits).toEqual([]);expect(h.delivered).toEqual([]);
 await h.press(501,`ng:a:${k}`,42);
 await vi.waitFor(()=>expect(JSON.stringify(h.edits)).toMatch(/new shared session/i));
 const edits=h.edits.length;await h.press(501,`ng:a:${k}`,42);   // replay
 await new Promise(r=>setTimeout(r,50));expect(h.edits.length).toBeLessThanOrEqual(edits+1);
 expect(JSON.stringify(h.edits.slice(edits))).not.toMatch(/Started a new shared session/);
 const cancel=await household();await cancel.s.open([],false,{transport:cancel.raw as never});
 await cancel.msg('/new');await vi.waitFor(()=>expect(cancel.shown).toHaveLength(1));
 await cancel.press(501,`ng:d:${key(cancel.shown[0])}`,42);await vi.waitFor(()=>expect(JSON.stringify(cancel.edits)).toMatch(/cancelled/i));
 await cancel.press(501,`ng:a:${key(cancel.shown[0])}`,42);await new Promise(r=>setTimeout(r,50));
 expect(JSON.stringify(cancel.edits)).not.toMatch(/Started a new shared session/);
});
test('group /new is refused while busy at request and at confirmation',async()=>{
 const h=await household();const gate=Promise.withResolvers<void>();
 await h.s.open([()=>gate.promise.then(()=>answer('LATE')),answer('AFTER')],false,{transport:h.raw as never});
 await h.msg('long task');await vi.waitFor(()=>expect(h.s.requests).toHaveLength(1));
 await h.msg('/new',43);await vi.waitFor(()=>expect(h.delivered.some(d=>/busy|stop/i.test(d.text))).toBe(true));
 expect(h.shown).toHaveLength(0);gate.resolve();await vi.waitFor(()=>expect(h.delivered.map(d=>d.text)).toContain('LATE'));
 await h.msg('/new',43);await vi.waitFor(()=>expect(h.shown).toHaveLength(1));
 const k=key(h.shown[0]),gate2=Promise.withResolvers<void>();
 (h.s as any).gate2=gate2;
 await h.msg('another');await vi.waitFor(()=>expect(h.s.requests.length).toBeGreaterThan(1));
 await h.press(501,`ng:a:${k}`,43);
 await vi.waitFor(()=>expect(JSON.stringify(h.edits)+JSON.stringify(h.delivered)).toMatch(/busy|expired|unavailable/i));
 expect(JSON.stringify(h.edits)).not.toMatch(/Started a new shared session/);
});
