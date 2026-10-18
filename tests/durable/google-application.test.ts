import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createNativeApplication } from '../../src/durable/application.js';
import { loadNativeConfig, type NativeConfig } from '../../src/durable/config.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(profile='durable-read-integrations-test') {
 const directory=await mkdtemp(join(tmpdir(),'native-tools-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const stateDir=join(directory,'state'),workspaceCwd=join(directory,'workspace'),vaultRoot=join(directory,'vault');
 await Promise.all([stateDir,workspaceCwd,vaultRoot].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 const config:NativeConfig={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:'a'.repeat(40),resourceRoot:resolve(import.meta.dirname,'../..'),workspaceCwd,stateDir,capabilityProfile:profile,account:'test',credentialPath:join(directory,'unused-auth'),settingsPath:join(directory,'unused-settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(directory,'unused.sock'),botId:123,allowedUserId:42},historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json'),memory:{vaultRoot,gitAutocommit:false,legacySessionRoots:[],timeZone:'UTC',recall:'off',semantic:'off'}};
 config.google={account:'reader@example.com',gog:{binary:join(directory,'fake-gog'),passwordFile:join(directory,'password'),home:join(directory,'gog-home')}};
 await mkdir(config.google.gog!.home,{mode:0o700});
 await writeFile(config.google.gog!.passwordFile,'fictional-password',{mode:0o600});
 await writeFile(config.google.gog!.binary,`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(directory,'calls'))},JSON.stringify({args,passwordOK:process.env.GOG_KEYRING_PASSWORD==='fictional-password',homeOK:process.env.GOG_HOME===${JSON.stringify(config.google.gog!.home)},secretAbsent:!process.env.GOOGLE_TEST_SECRET})+'\\n');
if(args.includes('BLOCK')){fs.writeFileSync(${JSON.stringify(join(directory,'pid'))},String(process.pid));setInterval(()=>{},1000);}
else if(args.includes('calendars')) console.log(JSON.stringify({calendars:[{id:'cal-1',summary:'Synthetic calendar',timeZone:'UTC',accessRole:'reader',primary:true}]}));
else if(args.includes('gmail')) console.log(JSON.stringify({threads:[{id:'thread-1',subject:'Synthetic mail',from:'sender@example.com'}]}));
else if(args.includes('search')) console.log(JSON.stringify({contacts:[{resource:'people/1'}]}));
else console.log(JSON.stringify({contact:{resourceName:'people/1',names:[{displayName:'Synthetic Person'}],phoneNumbers:[{value:'+1 (212) 555-0100'}]}}));
`,{mode:0o700});
 let hooks!:NativeTelegramHooks;const finals:string[]=[],requests:any[]=[];const fatal=vi.fn(),providerClose=vi.fn();
 const raw={start:async(value:NativeTelegramHooks)=>{hooks=value;return 'ready' as const;},stop:async()=>{},deliver:async(_target:unknown,text:string)=>{finals.push(text);return 100+finals.length;},present:async()=>200,edit:async()=>{},answerCallback:async()=>true};
 let app:Awaited<ReturnType<typeof createNativeApplication>>|undefined;
 cleanup.push(async()=>{await app?.close();});
 const open=async(responses:any[])=>{
  const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});
  faux.setResponses(responses.map(response=>(request:any)=>{requests.push(structuredClone(request));try{return typeof response==='function'?response(request):response;}catch(error){console.error('Synthetic provider assertion:',error);throw error;}}));
  const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
  app=await createNativeApplication(config,{provider:{models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',close:providerClose},transport:raw,onFatal:fatal,onTransportFailure:()=>{}});await app.start();return app;
 };
 const accept=(id:number,text:string,actor=42)=>hooks.accept({update_id:id,message:{message_id:1000+id,date:1700000000+id,from:{id:actor},chat:{id:actor,type:'private'},text}});
 return {directory,config,open,accept,finals,requests,fatal,providerClose,close:async()=>{try{await app?.close();}finally{app=undefined;}}};
}
const call=(name:string,args:unknown)=>fauxAssistantMessage(fauxToolCall(name,args as never),{stopReason:'toolUse'});
const result=(request:any)=>request.messages.filter((message:any)=>message.role==='toolResult').at(-1);
const text=(message:any)=>message.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join('\n');

test('read profile uses production transport, normalization and authority with explicit private configuration',async()=>{
 const s=await setup();vi.stubEnv('GOOGLE_TEST_SECRET','ambient-secret');cleanup.push(async()=>vi.unstubAllEnvs());
 await s.open([
  call('google_workspace',{operation:'calendar_list'}),
  (request:any)=>{expect(JSON.parse(text(result(request)))).toMatchObject({ok:true,result:{calendars:[{id:'cal-1',summary:'Synthetic calendar'}]}});return call('google_workspace',{operation:'gmail_search',query:'in:inbox'});},
  (request:any)=>{expect(JSON.parse(text(result(request)))).toMatchObject({ok:true,result:{threads:[{id:'thread-1',untrusted:true}]}});return call('google_workspace',{operation:'contacts_search',query:'Synthetic'});},
  (request:any)=>{expect(JSON.parse(text(result(request)))).toMatchObject({ok:true,result:{contacts:[{resource:'people/1',untrusted:true}]}});return fauxAssistantMessage('GOOGLE_DONE');},
 ]);
 await s.accept(1,'Read synthetic data.');await vi.waitFor(()=>expect(s.finals).toContain('GOOGLE_DONE'),{timeout:6000});
 const calls=(await readFile(join(s.directory,'calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(calls).toHaveLength(4);
 for(const entry of calls){expect(entry).toMatchObject({passwordOK:true,homeOK:true,secretAbsent:true});expect(entry.args).toEqual(expect.arrayContaining(['--readonly','--no-input','--gmail-no-send','--account','reader@example.com']));}
 const names=s.requests[0].messages.flatMap((m:any)=>m.toolsAdded??[]).map((t:any)=>t.name);expect(names).toContain('google_workspace');expect(names).toContain('web_fetch');
 await s.accept(2,'Unauthorized caller',99);expect(s.requests.length).toBe(4);expect(s.fatal).not.toHaveBeenCalled();
});

test('Google config is explicit, bounded, profile-specific and part of recovery compatibility',async()=>{
 const s=await setup();const {historyDir,inboxPath,runtimeMetadataPath,...input}=s.config;const path=join(s.directory,'instance.json');
 const load=async(value:unknown)=>{await writeFile(path,JSON.stringify(value),{mode:0o600});return loadNativeConfig(path);};
 expect((await load(input)).google).toEqual(s.config.google);
 for(const google of [undefined,{extra:true},{gog:{...s.config.google!.gog,binary:'relative'}},{places:{apiKeyFile:'/fictional/key',searchMonthlyLimit:-1,detailsMonthlyLimit:0,candidatesMonthlyLimit:0}},{calendarTargets:{account:'a@example.com',personal:'primary',thingsToDo:'stable'}}])await expect(load({...input,google})).rejects.toThrow();
 await expect(load({...input,principal:'engineering'})).rejects.toThrow(/principal/);
 await expect(load({...input,capabilityProfile:'durable-tools-test'})).rejects.toThrow(/Google configuration/);
 expect((await load({...input,google:{}})).google).toEqual({});
 await s.open([fauxAssistantMessage('SAVED')]);await s.accept(1,'Hello');await vi.waitFor(()=>expect(s.finals).toContain('SAVED'));await s.close();
 s.config.google!.account='changed@example.com';await expect(s.open([])).rejects.toThrow(/compatib|registry|changed/i);
});

test('host cancellation terminates an actual Google read child',async()=>{
 const s=await setup();let pid:number|undefined;
 cleanup.push(async()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{/* Already reaped. */}});
 const app=await s.open([call('google_workspace',{operation:'gmail_search',query:'BLOCK'})]);await s.accept(1,'Read synthetic slow response.');
 await vi.waitFor(async()=>{pid=Number(await readFile(join(s.directory,'pid'),'utf8'));expect(pid).toBeGreaterThan(1);},{timeout:3000});
 await app.host.abort('telegram-control:123:2',s.config.principal,{chatId:42});
 await vi.waitFor(()=>expect(()=>process.kill(pid!,0)).toThrow(),{timeout:3000});pid=undefined;
});

test('Places uses internal metered task, fixed HTTPS masks, identity cache and uncached attributed reviews',async()=>{
 const s=await setup();const keyFile=join(s.directory,'fictional-key');await writeFile(keyFile,'fictional-key',{mode:0o600});
 s.config.google={places:{apiKeyFile:keyFile,searchMonthlyLimit:1,detailsMonthlyLimit:2,candidatesMonthlyLimit:0}};
 const place={id:'place1',displayName:{text:'Synthetic Cafe'},googleMapsUri:'https://maps.google.com/place1',rating:4.5,reviews:[{rating:5,text:{text:'Synthetic review'},authorAttribution:{displayName:'Synthetic Author',uri:'https://maps.google.com/author'},googleMapsUri:'https://maps.google.com/review'}]};
 const fetch=vi.fn(async(url:URL,options:any)=>{
  expect(url.origin).toBe('https://places.googleapis.com');expect(options.headers['X-Goog-Api-Key']).toBe('fictional-key');
  return new Response(JSON.stringify(url.pathname.endsWith('searchText')?{places:[place]}:place));
 });vi.stubGlobal('fetch',fetch);cleanup.push(async()=>vi.unstubAllGlobals());
 const search={operation:'places_search',field_profile:'identity',query:'Synthetic cafe'};
 const rich={operation:'places_details',field_profile:'rich_details',place_id:'place1'};
 await s.open([
  call('google_workspace',search),
  (r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({ok:true,result:{cached:false,place:{source:'Google Maps'}}});return call('google_workspace',search);},
  (r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({ok:true,result:{cached:true}});return call('google_workspace',{...search,query:'Another cafe'});},
  (r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({ok:true,result:{blocked:true,reason:'monthly_limit'}});return call('google_workspace',rich);},
  (r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({ok:true,result:{cached:false,place:{reviews:[{authorAttribution:{displayName:'Synthetic Author'},googleMapsUri:'https://maps.google.com/review'}]}}});return call('google_workspace',rich);},
  (r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({ok:true,result:{cached:false}});return fauxAssistantMessage('PLACES_DONE');},
 ]);
 await s.accept(1,'Look up synthetic places.');await vi.waitFor(()=>expect(s.finals).toContain('PLACES_DONE'),{timeout:6000});
 expect(fetch).toHaveBeenCalledTimes(3);
 expect(fetch.mock.calls[0]![1].headers['X-Goog-FieldMask']).not.toContain('rating');expect(fetch.mock.calls[1]![1].headers['X-Goog-FieldMask']).toContain('reviews.authorAttribution');
 const names=s.requests[0].messages.flatMap((m:any)=>m.toolsAdded??[]).map((t:any)=>t.name);expect(names).toContain('google_workspace');expect(names).not.toContain('google_places_read');
});

test('host cancellation reaches a pending nested Places HTTPS read',async()=>{
 const s=await setup();const keyFile=join(s.directory,'abort-key');await writeFile(keyFile,'fictional-key',{mode:0o600});
 s.config.google={places:{apiKeyFile:keyFile,searchMonthlyLimit:1,detailsMonthlyLimit:1,candidatesMonthlyLimit:1}};
 let fetchStarted=false,fetchAborted=false;
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,options:RequestInit)=>{
  fetchStarted=true;
  return new Promise<Response>((_resolve,reject)=>{
   const abort=()=>{fetchAborted=true;reject(options.signal!.reason);};
   if(options.signal!.aborted)abort();else options.signal!.addEventListener('abort',abort,{once:true});
  });
 }));cleanup.push(async()=>vi.unstubAllGlobals());
 const app=await s.open([call('google_workspace',{operation:'places_search',field_profile:'identity',query:'Synthetic slow lookup'})]);
 await s.accept(1,'Read a synthetic place.');await vi.waitFor(()=>expect(fetchStarted).toBe(true),{timeout:3000});
 await app.host.abort('telegram-control:123:2',s.config.principal,{chatId:42});await vi.waitFor(()=>expect(fetchAborted).toBe(true),{timeout:3000});
});
