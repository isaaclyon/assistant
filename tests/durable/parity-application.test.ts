import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { context,Bindings } from '../../src/durable/ingress.js';
import { loadNativeConfig } from '../../src/durable/config.js';
import { setup, cleanup } from './parity-application-fixture.js';
const ok=(text:string)=>fauxAssistantMessage(text);
const call=(name:string,args:unknown)=>fauxAssistantMessage(fauxToolCall(name,args as never),{stopReason:'toolUse'});
const wait={timeout:12_000};
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

test('the selected parity profile restores missing transient classification without repeating a completed shell effect or losing queued replies',async()=>{
 const s=await setup();
 await s.open([call('bash',{command:'printf "effect\\n" >> effect.txt'}),fauxAssistantMessage([],{stopReason:'error',errorMessage:'Unknown error (no error details in response)'}),ok('RETRY_DONE'),ok('QUEUED_DONE')]);
 await s.accept('/debug');await s.accept('Run the synthetic effect.');await s.accept('Queued request.');
 await vi.waitFor(()=>expect(s.finals).toEqual(['RETRY_DONE','QUEUED_DONE']),wait);
 expect(await readFile(join(s.config.workspaceCwd,'effect.txt'),'utf8')).toBe('effect\n');
 expect(s.fatal).toHaveLength(0);
 expect(s.presented.some(text=>text.includes('durable tool')&&text.includes('bash'))).toBe(true);
 expect(s.presented.some(text=>text.includes('durable retry'))).toBe(true);
});

test('a provider idle timeout retries inside the production app and suppresses a late successful answer',async()=>{
 const s=await setup();const hold=Promise.withResolvers<void>();
 // Release the obsolete provider after its replacement answer commits.
 await s.open([async()=>{await hold.promise;return ok('OBSOLETE');},ok('AFTER_STALL')],false,{providerStallTimeoutMs:40});
 try{
  await s.accept('Synthetic stalled request.');
  await vi.waitFor(()=>expect(s.finals).toEqual(['AFTER_STALL']),wait);
  hold.resolve();await new Promise(resolve=>setTimeout(resolve,80));
  expect(s.finals).toEqual(['AFTER_STALL']);expect(s.fatal).toHaveLength(0);
 }finally{hold.resolve();}
});

test('selected hosted web uses stable store/conversation identity and exposes only lifecycle labels to debug',async()=>{
 const s=await setup();const bodies:Record<string,any>[]=[];
 const token=`x.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fictional-account'}})).toString('base64url')}.x`;
 await s.open([call('web_run',{search_query:[{q:'synthetic public topic',recency:7,domains:['example.com']}]}),call('web_run',{open:[{ref_id:'turn_fixture'}]}),ok('WEB_DONE')],false,{webRunFetch:async(_url,init)=>{
  bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({output_text:'Public result https://example.com',search_results:[],untrusted:'SECRET_SERVICE_EXTRA'}));
 }},models=>{
  const original=models.getModel.bind(models);
  vi.spyOn(models,'getModel').mockImplementation((provider,id)=>{const model=original(provider,id);return model?{...model,baseUrl:'https://chatgpt.com/backend-api'}:undefined;});
  vi.spyOn(models,'checkAuth').mockResolvedValue({type:'oauth',authenticated:true} as never);
  vi.spyOn(models,'getAuth').mockResolvedValue({auth:{apiKey:token}});
 });
 await s.accept('/debug');await s.accept('Read two public pages.');
 await vi.waitFor(()=>expect(s.finals).toEqual(['WEB_DONE']),wait);
 expect(bodies).toHaveLength(2);expect(bodies[0]!.id).toBe(bodies[1]!.id);expect(bodies[0]!.id).toMatch(/^[a-f0-9-]{36}:/);
 expect(s.requests.some(r=>JSON.stringify(r.messages).includes('Public result'))).toBe(true);
 expect(JSON.stringify([s.requests,s.finals,s.presented])).not.toMatch(/fictional-account|SECRET_SERVICE_EXTRA|Bearer /);
 expect(s.presented.some(text=>text.includes('web_run'))).toBe(true);
 // The same store/conversation reuses hosted refs after an orderly application restart.
 await s.close();
 const id=bodies[0]!.id;
 await s.open([call('web_run',{find:[{ref_id:'turn_fixture',pattern:'public'}]}),ok('REOPEN_DONE'),call('web_run',{search_query:[{q:'new conversation'}]}),ok('NEW_DONE')],false,{webRunFetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response('{"output_text":"reopened","search_results":[]}');}},models=>{
  const original=models.getModel.bind(models);vi.spyOn(models,'getModel').mockImplementation((p,i)=>{const m=original(p,i);return m?{...m,baseUrl:'https://chatgpt.com/backend-api'}:undefined;});
  vi.spyOn(models,'checkAuth').mockResolvedValue({type:'oauth'} as never);vi.spyOn(models,'getAuth').mockResolvedValue({auth:{apiKey:token}});
 });
 await s.accept('Continue the public reference.');await vi.waitFor(()=>expect(s.finals).toContain('REOPEN_DONE'),wait);
 expect(bodies[2]!.id).toBe(id);
 const host=s.app()!.host;const oldEpoch=(await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context))!.epoch;
 await s.accept('/new');await vi.waitFor(async()=>expect((await host.runtime.harness.snapshot(Bindings,host.runtime.root.id,context))!.epoch).toBeGreaterThan(oldEpoch),wait);
 await s.accept('Start a new search.');await vi.waitFor(()=>expect(s.finals).toContain('NEW_DONE'),wait);
 expect(bodies[3]!.id).not.toBe(id);expect(bodies[3]!.id.split(':')[0]).toBe(id.split(':')[0]);
 expect((await host.runtime.harness.inspect(context)).tasks).toHaveLength(0);
});

test('new guidance and profile boundaries are explicit while the preceding provider selection remains unchanged',async()=>{
 const s=await setup();const {historyDir,inboxPath,runtimeMetadataPath,...input}=s.config;const path=join(s.directory,'instance.json');
 await writeFile(path,JSON.stringify(input),{mode:0o600});expect((await loadNativeConfig(path)).capabilityProfile).toBe('durable-parity-test');
 await writeFile(path,JSON.stringify({...input,principal:'emma'}),{mode:0o600});await expect(loadNativeConfig(path)).rejects.toThrow(/principal/);
 await s.open([ok('GUIDANCE_DONE')]);await s.accept('Show the selected guidance.');await vi.waitFor(()=>expect(s.finals).toContain('GUIDANCE_DONE'),wait);
 const prompt=JSON.stringify(s.requests[0]);expect(prompt).toContain('private_opentable_login');expect(prompt).toContain('Book this exact reservation?');expect(prompt).toContain('PI_TELEGRAM_BRIDGE_RESOURCE_ROOT/.pi/skills/reserve-restaurant/scripts/opentable-search.mjs');
 expect(prompt).toContain('web_run');expect(prompt).not.toContain('use only `agent-browser auth login`');
 await s.close();
 const old=await setup('durable-provider-test');await old.open([ok('OLD_DONE')]);await old.accept('Old profile.');await vi.waitFor(()=>expect(old.finals).toContain('OLD_DONE'),wait);
 const oldPrompt=JSON.stringify(old.requests[0]);expect(oldPrompt).not.toContain('Book this exact reservation?');
 const names=old.app()!.host.config.registry.snapshot().tools().map(tool=>tool.tool.name);expect(names).not.toContain('web_run');
});
