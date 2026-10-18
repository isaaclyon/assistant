import { readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { cleanup, setup } from './parity-application-fixture.js';
import { Bindings, context } from '../../src/durable/ingress.js';
import { MediaOutbox } from '../../src/durable/media-outbound.js';
import type { NativeTelegramHooks } from '../../src/durable/transport.js';
import type { MediaPort } from '../../src/durable/media-transport.js';

afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const photon=createRequire(import.meta.url)('@silvia-odwyer/photon-node') as typeof import('@silvia-odwyer/photon-node');
const PNG=(()=>{const image=new photon.PhotonImage(new Uint8Array(4).fill(255),1,1);try{return Buffer.from(image.get_bytes());}finally{image.free();}})();
async function fixture(){
 const s=await setup('durable-personal-isaac');
 let hooks!:NativeTelegramHooks,id=10;
 const activity:string[]=[],events:string[]=[],uploads:FormData[]=[],files=new Map<string,Uint8Array>([['photo',PNG],['doc',Buffer.from('SYNTHETIC DOCUMENT')]]);
 let unknown=false;
 const media:MediaPort={call:async(method,body)=>{
  if(method==='getFile')return {status:200,payload:{ok:true,result:{file_path:`files/${(body as {file_id:string}).file_id}`}}};
  if(method==='sendMessage'||method==='editMessageText'){activity.push((body as {text:string}).text);return {status:200,payload:{ok:true,result:{message_id:++id}}};}
  if(method==='deleteMessage')return {status:200,payload:{ok:true,result:true}};
  uploads.push(body as FormData);events.push('upload');if(unknown)throw new Error('acknowledgement lost');
  return {status:200,payload:{ok:true,result:{message_id:++id}}};
 },file:async path=>new Response(files.get(path.slice(6)) as BodyInit)};
 const raw={media,start:async(h:NativeTelegramHooks)=>{hooks=h;return 'ready' as const;},stop:async()=>{},deliver:async(_target:unknown,text:string)=>{events.push(text);return ++id;},present:async()=>++id,edit:async()=>{},answerCallback:async()=>true};
 const message=(extra:Record<string,unknown>,at=1700000000)=>hooks.accept({update_id:++id,message:{message_id:id*10,date:at,from:{id:42},chat:{id:42,type:'private'},...extra}} as never);
 return {s,raw,media,message,activity,events,uploads,files,setUnknown:()=>{unknown=true;}};
}

test('the actual application supplies image blocks and verified document paths to the native model',async()=>{
 const f=await fixture();await f.s.open([answer('IMAGE'),answer('DOCUMENT')],false,{transport:f.raw});
 await f.message({photo:[{file_id:'photo',width:1,height:1}],caption:'Inspect this image'});
 await vi.waitFor(()=>expect(f.events).toContain('IMAGE'));
 const imageText=JSON.stringify(f.s.requests[0].messages);
 expect(imageText).toContain('"type":"image"');expect(imageText).toContain('Inspect this image');
 await f.message({document:{file_id:'doc',file_name:'synthetic.txt',mime_type:'text/plain'},caption:'Read this document'});
 await vi.waitFor(()=>expect(f.events).toContain('DOCUMENT'));
 const bindings=await f.s.app()!.host.runtime.harness.snapshot(Bindings,f.s.app()!.host.runtime.root.id,context);
 const doc=Object.values(bindings!.sources).find(b=>b.envelope.content.includes('Read this document'))!;
 const ref=doc.envelope.attachments![0] as {sourceKey:string;index:number;sha256:string};
 const {createMediaArtifactStore}=await import('../../src/durable/media-artifacts.js');
 const {path}=await createMediaArtifactStore({root:join(f.s.stateDir,'media')}).verifiedPath(ref);
 expect(JSON.stringify(f.s.requests[1].messages)).toContain(path);
 expect(await readFile(path,'utf8')).toBe('SYNTHETIC DOCUMENT');expect(f.s.fatal).toEqual([]);
});

test('corrupt images and unavailable voice are refused visibly before native admission',async()=>{
 const f=await fixture();f.files.set('photo',Buffer.from('not an image'));await f.s.open([],false,{transport:f.raw});
 await f.message({photo:[{file_id:'photo',width:1,height:1}]});
 await f.message({voice:{file_id:'voice',duration:1,mime_type:'audio/ogg'}});
 expect(f.events.join('\n')).toMatch(/refused|cannot be prepared/);expect(f.events.join('\n')).toMatch(/transcription provider/);
 expect(f.s.requests).toHaveLength(0);expect(f.s.fatal).toEqual([]);
});

test('the actual application sends immutable outbound files after final text and never retries an unknown upload across restart',async()=>{
 const f=await fixture(),path=join(f.s.config.workspaceCwd,'result.txt');await writeFile(path,'SYNTHETIC RESULT');f.setUnknown();
 await f.s.open([answer(fauxToolCall('telegram_attach',{paths:['result.txt']}),{stopReason:'toolUse'}),answer('FINAL')],false,{transport:f.raw});
 await f.message({text:'Send the result'});
 await vi.waitFor(()=>expect(f.events.some(event=>event.includes('may not have been delivered'))).toBe(true));
 expect(f.activity.join('\n')).toContain('telegram_attach');expect(f.activity.join('\n')).not.toContain('result.txt');
 expect(f.uploads).toHaveLength(1);expect(f.events.indexOf('FINAL')).toBeLessThan(f.events.indexOf('upload'));
 expect(await (f.uploads[0]!.get('document') as File).text()).toBe('SYNTHETIC RESULT');
 await f.s.close();await f.s.open([],false,{transport:f.raw});await f.s.app()!.host.reconcile();
 expect(f.uploads).toHaveLength(1);
 const doc=await f.s.app()!.host.runtime.harness.snapshot(MediaOutbox,f.s.app()!.host.runtime.root.id,context);
 expect(Object.values(doc!.items)[0]!.files[0]).toMatchObject({status:'uncertain',notice:'done'});expect(f.s.fatal).toEqual([]);
});

test('application recovery blocks the coordinator and transport before unbound legacy input can execute',async()=>{
 const s=await setup('durable-jobs-coordinator-test');let starts=0;
 await expect(s.open([],false,{transport:{start:async()=>{starts++;return 'ready';},stop:async()=>{},deliver:async()=>1,answerCallback:async()=>true}},undefined,async()=>{
  const db=new DatabaseSync(s.config.inboxPath);try{db.prepare('INSERT INTO pending_turn VALUES (?,?,?)').run('legacy:1','{"kind":"prompt","content":"held"}',1);}finally{db.close();}
 })).rejects.toThrow(/unbound|inbox/i);
 expect(starts).toBe(0);expect(s.requests).toEqual([]);
 expect(await readdir(s.config.coordinator!.coordinatorStateDir)).toEqual([]);
 const db=new DatabaseSync(s.config.inboxPath,{readOnly:true});try{expect(db.prepare('SELECT payload FROM pending_turn WHERE id=?').get('legacy:1')?.payload).toBe('{"kind":"prompt","content":"held"}');}finally{db.close();}
});

test('application routing is explicit and the idle human decision rotates exactly once',async()=>{
 const f=await fixture();let calls=0;
 f.s.config.routing={mode:'jev',judgeKeyFile:join(f.s.directory,'fictional-key')};
 await f.s.open([answer('FIRST'),answer('SECOND')],false,{transport:f.raw,routingJudge:async()=>{calls++;return {model:'fixture',probabilities:{same_conversation:0.1}};}});
 await f.message({text:'First subject'},1700000000);await vi.waitFor(()=>expect(f.events).toContain('FIRST'));
 await f.message({text:'New subject'},1700000901);await vi.waitFor(()=>expect(f.events).toContain('SECOND'));
 const state=await f.s.app()!.host.runtime.harness.snapshot(Bindings,f.s.app()!.host.runtime.root.id,context);
 expect(calls).toBe(1);expect(state!.epoch).toBe(1);expect(state!.lastHumanAt).toBe(1700000901000);expect(f.s.fatal).toEqual([]);
});
