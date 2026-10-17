import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTelegramTransport } from '../../src/durable/transport.js';
import { serveTrustedTelegram } from '../../src/trusted-telegram-ipc.js';
import type { TrustedTelegramTransport } from '../../src/trusted-telegram-transport.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const ok = (result: unknown) => new Response(JSON.stringify({ok:true,result}));
const pending = (signal: AbortSignal | null | undefined) => new Promise<Response>((_,reject) => {
  if (signal?.aborted) reject(new Error('aborted'));
  else signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'native-telegram-')); await chmod(dir,0o700);
  cleanups.push(()=>rm(dir,{recursive:true,force:true}));
  const configPath = join(dir,'telegram.json'); const locksPath = join(dir,'locks.json');
  const data = {botToken:'1:synthetic',botId:1,allowedUserId:7,profiles:{work:{botToken:'1:synthetic',botId:1,allowedUserId:7}}};
  await writeFile(configPath,JSON.stringify(data));
  return {dir,configPath,locksPath,data};
}
test('ordinary acceptance commits before named-profile offset advances; native preview and final preserve target',async()=>{
 const f=await fixture();const offsets:number[]=[];const sends:any[]=[];let release!:()=>void;let accepted=false;
 const gate=new Promise<void>(r=>release=r);
 const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,profile:'work',botId:1,allowedUserId:7,
 fetch:async(input,init)=>{const method=String(input).split('/').at(-1);const body=JSON.parse(String(init?.body));
 if(method==='getMe')return ok({id:1});
 if(method==='getUpdates'){offsets.push(body.offset);if(offsets.length===1)return ok([{update_id:10,message:{text:'hi'}}]);return pending(init?.signal);}
 sends.push({method,body});return ok({message_id:22});}});
 cleanups.push(()=>transport.stop());
 expect(await transport.start({accept:async()=>{accepted=true;await gate;}})).toBe('ready');
 await vi.waitFor(()=>expect(accepted).toBe(true));
 expect(offsets).toEqual([0]);expect(JSON.parse(await readFile(f.configPath,'utf8')).profiles.work.lastUpdateId).toBeUndefined();
 release();await vi.waitFor(()=>expect(offsets).toEqual([0,11]));
 const saved=JSON.parse(await readFile(f.configPath,'utf8'));expect(saved.profiles.work.lastUpdateId).toBe(10);expect(saved.lastUpdateId).toBeUndefined();
 await transport.preview({chatId:7,threadId:3},'hello');expect(await transport.deliver({chatId:7,threadId:3},'**hello**',9)).toBe(22);
 expect(sends.at(-1)).toMatchObject({method:'sendRichMessage',body:{chat_id:7,message_thread_id:3,reply_parameters:{message_id:9}}});
 expect(sends.filter(s=>s.method==='sendRichMessage')).toHaveLength(1);
});
test('valid external owner waits, dead owner recovers, delivery before ownership is definitely unsent',async()=>{
 const f=await fixture();await writeFile(f.locksPath,JSON.stringify({'@llblab/pi-telegram':{pid:process.ppid,cwd:'/external',heartbeatMs:0}}));
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>String(input).endsWith('/getMe')?ok({id:1}):pending(init?.signal));
 const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,botId:1,allowedUserId:7,fetch:fetcher});cleanups.push(()=>transport.stop());
 expect(await transport.start({accept:async()=>{}})).toBe('waiting-owner');expect(fetcher).not.toHaveBeenCalled();
 await expect(transport.deliver({chatId:7},'hello')).rejects.toMatchObject({definitelyNotSent:true});
 await writeFile(f.locksPath,JSON.stringify({'@llblab/pi-telegram':{pid:2147483647,cwd:'/dead'}}));
 void transport.reconcile();await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 expect(JSON.parse(await readFile(f.locksPath,'utf8'))['@llblab/pi-telegram'].pid).toBe(process.pid);
});
test('pairing revoked while polling cannot reach acceptance or acknowledge update',async()=>{
 const f=await fixture();let release!:(response:Response)=>void;const accept=vi.fn();const failed=vi.fn();
 const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,botId:1,allowedUserId:7,
 fetch:async(input)=>String(input).endsWith('/getMe')?ok({id:1}):new Promise<Response>(r=>release=r)});cleanups.push(()=>transport.stop());
 await transport.start({accept,failed});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 await writeFile(f.configPath,JSON.stringify({...f.data,allowedUserId:8}));release(ok([{update_id:10}]));
 await vi.waitFor(()=>expect(failed).toHaveBeenCalled());expect(accept).not.toHaveBeenCalled();
 expect(JSON.parse(await readFile(f.configPath,'utf8')).lastUpdateId).toBeUndefined();
});
test('failed startup releases lock and rejects readiness',async()=>{
 const f=await fixture();const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,botId:1,allowedUserId:7,fetch:async()=>ok({id:2})});
 await expect(transport.start({accept:async()=>{}})).rejects.toThrow('identity');
 expect(JSON.parse(await readFile(f.locksPath,'utf8'))).toEqual({});
});
test('real restricted IPC reconnect replays unaccepted input and never falls through to fetch',async()=>{
 const f=await fixture();const offsets:number[]=[];let acceptCount=0;let failed=0;
 const server=await serveTrustedTelegram(join(f.dir,'broker.sock'),{runtimeCall:async(method:string,body:any)=>{
   if(method==='getMe')return ok({id:1});
   if(method==='getUpdates'){offsets.push(body.offset); if(offsets.length<=2)return ok([{update_id:5}]);return new Response('{}',{status:503});}
   return ok({message_id:9});
 }} as TrustedTelegramTransport);
 cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const direct=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('direct forbidden'));
 const transport=createNativeTelegramTransport({mode:'restricted',socketPath:join(f.dir,'broker.sock'),botId:1,allowedUserId:7});cleanups.push(()=>transport.stop());
 await transport.start({accept:async()=>{if(++acceptCount===1)throw new Error('storage failed');},failed:()=>{failed++;}});
 await vi.waitFor(()=>expect(failed).toBe(1));expect(offsets).toEqual([0]);
 await transport.reconcile();expect(offsets).toEqual([0,0,6]);expect(acceptCount).toBe(2);expect(direct).not.toHaveBeenCalled();
});

test('offset persistence failure preserves accepted update for deduplicated replay',async()=>{
 const f=await fixture();const offsets:number[]=[];const failed=vi.fn();let attempts=0;
 const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,botId:1,allowedUserId:7,
 fetch:async(input,init)=>{if(String(input).endsWith('/getMe'))return ok({id:1});
 offsets.push(JSON.parse(String(init?.body)).offset);if(offsets.length<=2)return ok([{update_id:12}]);return pending(init?.signal);}});
 cleanups.push(()=>transport.stop());
 await transport.start({accept:async()=>{if(++attempts===1){await rm(f.configPath);await mkdir(f.configPath);}},failed});
 await vi.waitFor(()=>expect(failed).toHaveBeenCalled());expect(offsets).toEqual([0]);
 await rm(f.configPath,{recursive:true});await writeFile(f.configPath,JSON.stringify(f.data));
 void transport.reconcile();await vi.waitFor(()=>expect(offsets).toEqual([0,0,13]));expect(attempts).toBe(2);
});

test('final effects are single-send and missing acknowledgement remains uncertain',async()=>{
 const f=await fixture();let sends=0;
 const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,botId:1,allowedUserId:7,
 fetch:async(input,init)=>{if(String(input).endsWith('/getMe'))return ok({id:1});
 if(String(input).endsWith('/getUpdates'))return pending(init?.signal);
 sends++;return ok({});}});cleanups.push(()=>transport.stop());
 await transport.start({accept:async()=>{}});
 await expect(transport.deliver({chatId:7},'x'.repeat(5000))).rejects.toMatchObject({definitelyNotSent:true});expect(sends).toBe(0);
 await expect(transport.deliver({chatId:7},'hello')).rejects.toMatchObject({outcome:'uncertain',definitelyNotSent:false});expect(sends).toBe(1);
});

test('ordinary outbound effects recheck pairing and never send after revocation',async()=>{
 const f=await fixture();let sends=0;
 const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,botId:1,allowedUserId:7,
 fetch:async(input,init)=>{if(String(input).endsWith('/getMe'))return ok({id:1});if(String(input).endsWith('/getUpdates'))return pending(init?.signal);sends++;return ok({message_id:9});}});
 cleanups.push(()=>transport.stop());await transport.start({accept:async()=>{}});
 await writeFile(f.configPath,JSON.stringify({...f.data,allowedUserId:8}));
 await expect(transport.deliver({chatId:7},'held answer')).rejects.toMatchObject({definitelyNotSent:true});
 await expect(transport.answerCallback('synthetic','reply')).rejects.toMatchObject({definitelyNotSent:true});expect(sends).toBe(0);
});
test('rich presentations and edits pass the per-effect pairing check and validate markup',async()=>{
 const f=await fixture();const sends:any[]=[];
 const transport=createNativeTelegramTransport({mode:'ordinary',...f,cwd:f.dir,botId:1,allowedUserId:7,
 fetch:async(input,init)=>{const method=String(input).split('/').at(-1);const body=JSON.parse(String(init?.body));
 if(method==='getMe')return ok({id:1});if(method==='getUpdates')return pending(init?.signal);sends.push({method,body});return ok({message_id:5});}});
 cleanups.push(()=>transport.stop());await transport.start({accept:async()=>{}});
 expect(await transport.present({chatId:7},{text:'Pick',buttons:[[{text:'Max',callback:'tl:max'}]]})).toBe(5);
 expect(sends.at(-1)).toMatchObject({method:'sendMessage',body:{chat_id:7,text:'Pick',reply_markup:{inline_keyboard:[[{text:'Max',callback_data:'tl:max'}]]}}});
 await transport.edit({chatId:7},5,{text:'Done'});expect(sends.at(-1)).toMatchObject({method:'editMessageText',body:{message_id:5,reply_markup:{inline_keyboard:[]}}});
 await expect(transport.present({chatId:7},{text:'x',buttons:[[{text:'bad',callback:'free-form'}]]})).rejects.toThrow();
 // Revoked pairing blocks the next UI effect.
 await writeFile(f.configPath,JSON.stringify({...f.data,allowedUserId:8,profiles:undefined}));
 const before=sends.length;await expect(transport.present({chatId:7},{text:'y'})).rejects.toMatchObject({definitelyNotSent:true});expect(sends).toHaveLength(before);
});
