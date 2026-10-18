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
async function setup() {
 const directory=await mkdtemp(join(tmpdir(),'native-cli-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const stateDir=join(directory,'state'),workspaceCwd=join(directory,'workspace'),vaultRoot=join(directory,'vault'),home=join(directory,'home'),bin=join(directory,'bin');
 await Promise.all([stateDir,workspaceCwd,vaultRoot,home,bin,join(home,'.bun/bin'),join(home,'.config/pi-telegram-bridge')].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 const config:NativeConfig={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:'a'.repeat(40),resourceRoot:resolve(import.meta.dirname,'../..'),workspaceCwd,stateDir,capabilityProfile:'durable-cli-integrations-test',account:'test',credentialPath:join(directory,'unused-auth'),settingsPath:join(directory,'unused-settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(directory,'unused.sock'),botId:123,allowedUserId:42},historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json'),memory:{vaultRoot,gitAutocommit:false,legacySessionRoots:[],timeZone:'UTC',recall:'off',semantic:'off'},google:{}};
 config.cli={messagesBaseUrl:'https://synthetic.test:8443/'};
 vi.stubEnv('HOME',home);vi.stubEnv('PATH',`${bin}:${process.env.PATH}`);vi.stubEnv('PI_TELEGRAM_MESSAGES_BASE_URL','https://ambient.invalid/');vi.stubEnv('YNAB_ACCESS_TOKEN','ambient-fictional-secret');cleanup.push(async()=>vi.unstubAllEnvs());
 await writeFile(join(home,'.config/pi-telegram-bridge/ynab.json'),JSON.stringify({budget_id:'synthetic-budget'}),{mode:0o600});
 const executable=`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(directory,'calls'))},JSON.stringify({args,bun:process.argv[1].includes('.bun'),secretAbsent:!process.env.YNAB_ACCESS_TOKEN})+'\\n');
if(args[0]==='auth')console.log(JSON.stringify({authenticated:true}));
else if(args[0]==='categories')console.log(JSON.stringify([{name:'Everyday',categories:[{id:'dining',name:'Dining'}]}]));
else if(args[1]==='view')console.log(JSON.stringify({id:args[2],payee_name:'Synthetic Merchant',amount:-12.34,approved:false}));
else if(args[1]==='search')console.log(JSON.stringify([{id:'old',payee_name:'Synthetic Merchant',category_name:'Dining',date:'2026-01-01',amount:-10}]));
else if(args[1]==='create'){fs.appendFileSync(${JSON.stringify(join(directory,'effects'))},'created\\n');console.log(JSON.stringify({id:'created-1',amount:-12.34}));}
else process.exit(2);
`;
 await Promise.all([join(bin,'ynab'),join(home,'.bun/bin/ynab')].map(path=>writeFile(path,executable,{mode:0o700})));
 let hooks!:NativeTelegramHooks;const finals:string[]=[],requests:any[]=[];const fatal=vi.fn();
 const raw={start:async(value:NativeTelegramHooks)=>{hooks=value;return 'ready' as const;},stop:async()=>{},deliver:async(_target:unknown,text:string)=>{finals.push(text);return 100+finals.length;},present:async()=>200,edit:async()=>{},answerCallback:async()=>true};
 let app:Awaited<ReturnType<typeof createNativeApplication>>|undefined;cleanup.push(async()=>{await app?.close();});
 const open=async(responses:any[])=>{
  const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});
  faux.setResponses(responses.map(response=>(request:any)=>{requests.push(structuredClone(request));return typeof response==='function'?response(request):response;}));
  const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();
  app=await createNativeApplication(config,{provider:{models,provider:faux.provider,model:{provider:model.provider,modelId:model.id},thinkingLevel:'off',close:async()=>{}},transport:raw,onFatal:fatal,onTransportFailure:()=>{}});await app.start();return app;
 };
 const accept=(id:number,text:string,actor=42)=>hooks.accept({update_id:id,message:{message_id:1000+id,date:1700000000+id,from:{id:actor},chat:{id:actor,type:'private'},text}});
 return {directory,home,bin,config,open,accept,finals,requests,fatal,close:async()=>{try{await app?.close();}finally{app=undefined;}}};
}
const call=(command:string)=>fauxAssistantMessage(fauxToolCall('bash',{command,timeout:5}),{stopReason:'toolUse'});
const result=(request:any)=>request.messages.filter((message:any)=>message.role==='toolResult').at(-1);
const text=(message:any)=>[...(typeof message.content==='string'?[message.content]:message.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text)),...Object.values(message.sections??{})].join('\n');
const helper=(name:string)=>`"${process.execPath}" "$PI_TELEGRAM_BRIDGE_RESOURCE_ROOT/.pi/skills/manage-ynab/scripts/${name}.mjs"`;

test('CLI profile runs selected release helpers from a separate workspace using PATH before Bun fallback',async()=>{
 const s=await setup();
 await s.open([
  call('ynab auth status'),
  (r:any)=>{expect(JSON.parse(text(result(r)))).toEqual({authenticated:true});return call(helper('list-ynab-categories'));},
  (r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({categories:[{id:'dining',group:'Everyday'}]});return call(helper('ynab-transaction-context')+' 11111111-1111-1111-1111-111111111111');},
  (r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({transaction:{payee:'Synthetic Merchant'},exactPayeeHistory:{transactionCount:1,categoryCounts:[{category:'Dining',count:1}]}});return fauxAssistantMessage('CLI_DONE');},
 ]);
 await s.accept(1,'Read synthetic YNAB categories and transaction.');await vi.waitFor(()=>expect(s.finals).toContain('CLI_DONE'),{timeout:6000});
 const calls=(await readFile(join(s.directory,'calls'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(calls).toHaveLength(4);
 expect(calls.every(c=>!c.bun&&c.secretAbsent)).toBe(true);for(const c of calls.slice(1))expect(c.args).toEqual(expect.arrayContaining(['--budget','synthetic-budget']));
 const instructions=s.requests[0].messages.filter((m:any)=>m.role==='system').map(text).join('\n');
 expect(instructions).toContain('# Manage YNAB');expect(instructions).toContain('# Create an editable Messages link');expect(instructions).toContain('interrupted');expect(instructions).toContain('Ask for typed transaction details.');expect(instructions).not.toContain('saved place rankings and Messages-link workflows');
 await s.accept(2,'Unauthorized caller',99);expect(s.requests).toHaveLength(4);expect(s.fatal).not.toHaveBeenCalled();
});

test('YNAB helper uses Bun fallback when the executable is absent from PATH',async()=>{
 const s=await setup();await rm(join(s.bin,'ynab'));vi.stubEnv('PATH','/usr/bin:/bin');
 await s.open([call(helper('list-ynab-categories')),(r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({categories:[{id:'dining'}]});return fauxAssistantMessage('FALLBACK_DONE');}]);
 await s.accept(1,'Read synthetic fallback categories.');await vi.waitFor(()=>expect(s.finals).toContain('FALLBACK_DONE'),{timeout:6000});
 expect(JSON.parse((await readFile(join(s.directory,'calls'),'utf8')).trim())).toMatchObject({bun:true,secretAbsent:true});
});

test('YNAB helper reports a PATH executable failure without retrying the Bun installation',async()=>{
 const s=await setup();await writeFile(join(s.bin,'ynab'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(s.directory,'calls'))},'failed\\n');process.stderr.write('synthetic failure');process.exitCode=1;\n`,{mode:0o700});
 await s.open([call(helper('list-ynab-categories')),(r:any)=>{expect(result(r).isError).toBe(true);expect(text(result(r))).toContain('Could not list YNAB categories.');expect(text(result(r))).not.toContain('synthetic failure');return fauxAssistantMessage('FAILURE_REPORTED');}]);
 await s.accept(1,'Read synthetic failing categories.');await vi.waitFor(()=>expect(s.finals).toContain('FAILURE_REPORTED'),{timeout:6000});
 expect(await readFile(join(s.directory,'calls'),'utf8')).toBe('failed\n');
});

test('Messages uses explicit private origin and keeps the draft exclusively in the fragment',async()=>{
 const s=await setup();const draft={to:'+1 (212) 555-0100',label:'Synthetic Person',body:'Editable & private? # yes'};
 const command=`printf '%s' '${JSON.stringify(draft)}' | "${process.execPath}" "$PI_TELEGRAM_BRIDGE_RESOURCE_ROOT/.pi/skills/message-link/scripts/messages-link.mjs"`;
 await s.open([call(command),(r:any)=>{const {url}=JSON.parse(text(result(r)));const parsed=new URL(url);expect(parsed.origin).toBe('https://synthetic.test:8443');expect(parsed.pathname).toBe('/');expect(parsed.search).toBe('');expect(Object.fromEntries(new URLSearchParams(parsed.hash.slice(1)))).toEqual({...draft,to:'+12125550100'});return fauxAssistantMessage('DRAFT_DONE');}]);
 await s.accept(1,'Prepare a synthetic text draft.');await vi.waitFor(()=>expect(s.finals).toContain('DRAFT_DONE'),{timeout:6000});
 await expect(readFile(join(s.directory,'effects'))).rejects.toMatchObject({code:'ENOENT'});
});

test('synthetic authorized CLI write returns its result once through replay-unsafe shell',async()=>{
 const s=await setup();await s.open([call('ynab transactions create --budget synthetic-budget --account synthetic-account --amount -12.34 --approved'),(r:any)=>{expect(JSON.parse(text(result(r)))).toMatchObject({id:'created-1',amount:-12.34});return fauxAssistantMessage('WRITE_DONE');}]);
 await s.accept(1,'Create the synthetic transaction.');await vi.waitFor(()=>expect(s.finals).toContain('WRITE_DONE'),{timeout:6000});
 expect(await readFile(join(s.directory,'effects'),'utf8')).toBe('created\n');
});

test('CLI configuration is profile-specific, rejects invalid origins and blocks changed recovery configuration',async()=>{
 const s=await setup();const {historyDir,inboxPath,runtimeMetadataPath,...input}=s.config;const path=join(s.directory,'instance.json');
 const load=async(value:unknown)=>{await writeFile(path,JSON.stringify(value),{mode:0o600});return loadNativeConfig(path);};
 expect(await load(input)).toMatchObject({capabilityProfile:'durable-cli-integrations-test',cli:{messagesBaseUrl:'https://synthetic.test:8443/'}});
 for(const cli of [{extra:true},{messagesBaseUrl:'http://example.test/'},{messagesBaseUrl:'https://user:password@example.test/'},{messagesBaseUrl:'https://example.test/path'},{messagesBaseUrl:'https://example.test/?draft=x'},{messagesBaseUrl:'https://example.test/#draft'},null])await expect(load({...input,cli})).rejects.toThrow();
 for(const capabilityProfile of ['durable-read-integrations-test','durable-tools-test','durable-chat-memory-test'])await expect(load({...input,capabilityProfile})).rejects.toThrow();
 await expect(load({...input,principal:'engineering'})).rejects.toThrow(/principal/);
 expect(await load({...input,cli:{}})).toMatchObject({cli:{}});
 await s.open([fauxAssistantMessage('SAVED')]);await s.accept(1,'Hello');await vi.waitFor(()=>expect(s.finals).toContain('SAVED'));await s.close();
 s.config.cli={messagesBaseUrl:'https://changed.test/'};await expect(s.open([])).rejects.toThrow('Incompatible native host metadata');
});

test('absent Messages configuration uses bounded hostname discovery without inheriting ambient origin',async()=>{
 const s=await setup();delete s.config.cli;
 await writeFile(join(s.bin,'tailscale'),`#!${process.execPath}\nconsole.log(JSON.stringify({Self:{DNSName:'synthetic.ts.net.'}}));\n`,{mode:0o700});
 const draft={to:'+12125550100',label:'Synthetic',body:'Draft'};
 const command=`printf '%s' '${JSON.stringify(draft)}' | "${process.execPath}" "$PI_TELEGRAM_BRIDGE_RESOURCE_ROOT/.pi/skills/message-link/scripts/messages-link.mjs"`;
 await s.open([call(command),(r:any)=>{const {url}=JSON.parse(text(result(r)));expect(new URL(url).origin).toBe('https://synthetic.ts.net:8443');return fauxAssistantMessage('DISCOVERY_DONE');}]);
 await s.accept(1,'Prepare synthetic fallback draft.');await vi.waitFor(()=>expect(s.finals).toContain('DISCOVERY_DONE'),{timeout:6000});
});

test('previous read profile keeps CLI skills and Messages origin unselected',async()=>{
 const s=await setup();s.config.capabilityProfile='durable-read-integrations-test';delete s.config.cli;
 await s.open([call('printf "%s" "${PI_TELEGRAM_MESSAGES_BASE_URL-absent}"'),(r:any)=>{expect(text(result(r))).toBe('absent');return fauxAssistantMessage('READ_PROFILE_DONE');}]);
 await s.accept(1,'Inspect synthetic profile selection.');await vi.waitFor(()=>expect(s.finals).toContain('READ_PROFILE_DONE'),{timeout:6000});
 const instructions=s.requests[0].messages.filter((m:any)=>m.role==='system').map(text).join('\n');
 expect(instructions).not.toContain('# Manage YNAB');expect(instructions).not.toContain('# Create an editable Messages link');
});
