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
async function setup(profile='durable-tools-test') {
 const directory=await mkdtemp(join(tmpdir(),'native-tools-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const stateDir=join(directory,'state'),workspaceCwd=join(directory,'workspace'),vaultRoot=join(directory,'vault');
 await Promise.all([stateDir,workspaceCwd,vaultRoot].map(path=>mkdir(path,{recursive:true,mode:0o700})));
 const config:NativeConfig={version:1,runtime:'pi-durable',instanceId:'test',principal:'isaac',releaseSha:'a'.repeat(40),resourceRoot:resolve(import.meta.dirname,'../..'),workspaceCwd,stateDir,capabilityProfile:profile,account:'test',credentialPath:join(directory,'unused-auth'),settingsPath:join(directory,'unused-settings'),jobsRole:'disabled',idleHours:0,transport:{mode:'broker',socketPath:join(directory,'unused.sock'),botId:123,allowedUserId:42},historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json'),memory:{vaultRoot,gitAutocommit:false,legacySessionRoots:[],timeZone:'UTC',recall:'off',semantic:'off'}};
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

test('new tools profile is explicit and requires the same private memory authority',async()=>{
 const s=await setup();const {historyDir,inboxPath,runtimeMetadataPath,...input}=s.config;
 const path=join(s.directory,'instance.json');await writeFile(path,JSON.stringify(input),{mode:0o600});
 expect((await loadNativeConfig(path)).capabilityProfile).toBe('durable-tools-test');
 await writeFile(path,JSON.stringify({...input,principal:'engineering'}));
 await expect(loadNativeConfig(path)).rejects.toThrow(/principal/);
});

test('selected production composition performs file tools in configured workspace and preserves C3 profile selection',async()=>{
 const s=await setup();const outside=join(s.directory,'outside.txt');await writeFile(outside,'ABSOLUTE_READ');
 await s.open([
  call('write',{path:'sub/fixture.txt',content:'one\ntwo\n'}),
  (request:any)=>{expect(result(request).isError).not.toBe(true);return call('edit',{path:'sub/fixture.txt',edits:[{oldText:'two',newText:'three'}]});},
  (request:any)=>{expect(result(request).isError).not.toBe(true);return call('read',{path:'sub/fixture.txt',offset:2,limit:1});},
  (request:any)=>{expect(text(result(request))).toContain('three');return call('read',{path:outside});},
  (request:any)=>{expect(text(result(request))).toContain('ABSOLUTE_READ');return call('bash',{command:'pwd; printf SHELL_OK',timeout:2});},
  (request:any)=>{expect(text(result(request))).toContain(s.config.workspaceCwd);expect(text(result(request))).toContain('SHELL_OK');return fauxAssistantMessage('TOOLS_DONE');},
 ]);
 await s.accept(1,'Use the selected file and shell tools.');await vi.waitFor(()=>expect(s.finals).toContain('TOOLS_DONE'),{timeout:6000});
 expect(await readFile(join(s.config.workspaceCwd,'sub/fixture.txt'),'utf8')).toBe('one\nthree\n');
 const names=s.requests[0].messages.flatMap((m:any)=>m.toolsAdded??[]).map((t:any)=>t.name);
 expect(names).toEqual(expect.arrayContaining(['read','write','edit','bash','grep','find','ls','web_fetch','web_search','assistant_memory']));
 expect(s.fatal).not.toHaveBeenCalled();
 await s.close();
 const c3=await setup('durable-chat-memory-test');await c3.open([fauxAssistantMessage('C3_ONLY')]);await c3.accept(1,'Hello');
 await vi.waitFor(()=>expect(c3.finals).toContain('C3_ONLY'));
 expect(c3.requests[0].messages.flatMap((m:any)=>m.toolsAdded??[]).map((t:any)=>t.name).sort()).toEqual(['assistant_memory','assistant_memory_search','assistant_session_search','search_index','session_context']);
});

test('inspection tools use argument arrays, honor gitignore, handle no matches and include hidden entries',async()=>{
 const s=await setup();await writeFile(join(s.config.workspaceCwd,'.gitignore'),'ignored.txt\n');await mkdir(join(s.config.workspaceCwd,'.git'));
 await writeFile(join(s.config.workspaceCwd,'visible.txt'),'a.b\nother\n');await writeFile(join(s.config.workspaceCwd,'ignored.txt'),'a.b\n');
 await s.open([
  call('grep',{pattern:'a.b',literal:true,path:'.',glob:'*.txt'}),
  (request:any)=>{expect(text(result(request))).toContain('visible.txt:1:a.b');expect(text(result(request))).not.toContain('ignored.txt');return call('find',{pattern:'*.txt'});},
  (request:any)=>{expect(text(result(request))).toContain('visible.txt');expect(text(result(request))).not.toContain('ignored.txt');return call('ls',{});},
  (request:any)=>{expect(text(result(request))).toContain('.gitignore');return call('grep',{pattern:'NO_MATCH'});},
  (request:any)=>{expect(result(request).isError).not.toBe(true);expect(text(result(request))).toContain('No matches');return call('grep',{pattern:'$(touch injected-effect)',literal:true});},
  (request:any)=>{expect(text(result(request))).toContain('No matches');return fauxAssistantMessage('INSPECTION_DONE');},
 ]);
 await s.accept(1,'Inspect synthetic files.');await vi.waitFor(()=>expect(s.finals).toContain('INSPECTION_DONE'),{timeout:6000});
 await expect(readFile(join(s.config.workspaceCwd,'injected-effect'))).rejects.toMatchObject({code:'ENOENT'});
});

test('shell deadline, output limit and environment exclude ambient secrets',async()=>{
 const s=await setup();vi.stubEnv('C4_TEST_SECRET_TOKEN','SHOULD_NOT_LEAK');cleanup.push(async()=>{vi.unstubAllEnvs();});
 await s.open([
  call('bash',{command:'printf "%s" "${C4_TEST_SECRET_TOKEN-absent}"'}),
  (request:any)=>{expect(text(result(request))).toBe('absent');return call('bash',{command:'printf TIMEOUT_STARTED; sleep 10',timeout:0.05});},
  (request:any)=>{expect(result(request).isError).toBe(true);expect(text(result(request))).toContain('TIMEOUT_STARTED');return call('bash',{command:'touch invalid-timeout-effect',timeout:301});},
  (request:any)=>{expect(result(request).isError).toBe(true);expect(text(result(request))).toContain('300');return call('bash',{command:`node -e "process.stdout.write('x'.repeat(100000))"`,timeout:2});},
  (request:any)=>{expect(Buffer.byteLength(text(result(request)))).toBeLessThan(52000);return fauxAssistantMessage('BOUNDED_DONE');},
 ]);
 await s.accept(1,'Exercise bounded shell calls.');await vi.waitFor(()=>expect(s.finals).toContain('BOUNDED_DONE'),{timeout:7000});
 await expect(readFile(join(s.config.workspaceCwd,'invalid-timeout-effect'))).rejects.toMatchObject({code:'ENOENT'});
});


test('host abort terminates an actual shell child process',async()=>{
 const s=await setup();let childPid:number|undefined;
 cleanup.push(async()=>{if(childPid){try{process.kill(childPid,'SIGKILL');}catch{/* Already reaped by the SDK. */}}});
 const app=await s.open([call('bash',{command:`node -e "require('fs').writeFileSync('shell-child-pid',String(process.pid));setInterval(()=>{},1000)"`,timeout:30})]);
 await s.accept(1,'Start a synthetic long command.');
 await vi.waitFor(async()=>{childPid=Number(await readFile(join(s.config.workspaceCwd,'shell-child-pid'),'utf8'));expect(childPid).toBeGreaterThan(1);},{timeout:3000});
 await app.host.abort('telegram-control:123:2',s.config.principal,{chatId:42});
 await vi.waitFor(()=>{expect(()=>process.kill(childPid!,0)).toThrow();},{timeout:3000});
 childPid=undefined;
});


test('application cleanup closes remaining resources once even if host cleanup rejects',async()=>{
 const s=await setup(),app=await s.open([]);const closeHost=app.host.close.bind(app.host);
 app.host.close=async()=>{await closeHost();throw new Error('SYNTHETIC_CLOSE_FAILURE');};
 const closeSearch=vi.spyOn(app.search!,'close');
 await expect(s.close()).rejects.toThrow('cleanup failed');
 await expect(app.close()).rejects.toThrow('cleanup failed');
 expect(s.providerClose).toHaveBeenCalledTimes(1);expect(closeSearch).toHaveBeenCalledTimes(1);
});


test('inspection rejects expansive globs and reports incomplete raw captures honestly',async()=>{
 const s=await setup();await writeFile(join(s.config.workspaceCwd,'long.txt'),'x'.repeat(100000));
 await s.open([
  call('find',{pattern:'{a,b}*.txt'}),
  (request:any)=>{expect(result(request).isError).toBe(true);expect(text(result(request))).toContain('simple glob');return call('grep',{pattern:'x',path:'long.txt'});},
  (request:any)=>{expect(text(result(request))).toContain('Inspection incomplete');expect(text(result(request))).not.toContain('No matches found.');return fauxAssistantMessage('INCOMPLETE_REPORTED');},
 ]);
 await s.accept(1,'Check bounded inspection.');await vi.waitFor(()=>expect(s.finals).toContain('INCOMPLETE_REPORTED'),{timeout:3000});
});
