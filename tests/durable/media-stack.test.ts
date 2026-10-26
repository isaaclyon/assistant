import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMediaStackBundle,callMediaGateway} from '../../src/durable/media-stack.js';
const {createGateway}=await import(new URL('../../scripts/media-gateway.mjs',import.meta.url).href);
const dirs:string[]=[];const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0))await close();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const config=(socketPath?:string)=>({...(socketPath?{mediaStack:{socketPath}}:{})}) as any;
const tool=(bundle:any,name:string)=>bundle.tools.find((t:any)=>t.tool.name===name).tool;
const run=async(t:any,input:unknown)=>{const result=await t.execute(input,{} as any,{} as any);return JSON.parse(result.output[0].text);};

it('registers no tools until a gateway socket is configured',()=>{
 expect(createMediaStackBundle(config()).tools).toEqual([]);
 const bundle=createMediaStackBundle(config('/run/m.sock'));
 expect(bundle.tools.map(t=>[t.tool.name,t.tool.replay])).toEqual([['media_stack','safe'],['media_request','unsafe']]);
});

it('sends only the selected operation arguments and shapes results',async()=>{
 const calls:any[]=[];
 const bundle=createMediaStackBundle(config('/run/m.sock'),async(path,op,args)=>{calls.push([path,op,args]);return {ok:true,result:{queue:[]}};});
 expect(await run(tool(bundle,'media_stack'),{operation:'library_search',query:'bear',kind:undefined})).toEqual({ok:true,result:{queue:[]},error:null});
 expect(calls).toEqual([['/run/m.sock','library_search',{query:'bear'}]]);
});

it('requests need an exact season choice for TV and none for movies, and map to the collector shape',async()=>{
 const calls:any[]=[];
 const bundle=createMediaStackBundle(config('/run/m.sock'),async(_p,op,args)=>{calls.push([op,args]);return {ok:true,result:{requestId:1}};});
 const request=tool(bundle,'media_request');
 expect((await run(request,{media_type:'tv',media_id:5})).error.code).toBe('INPUT_INVALID');
 expect((await run(request,{media_type:'tv',media_id:5,seasons:[1],all_seasons:true})).error.code).toBe('INPUT_INVALID');
 expect((await run(request,{media_type:'movie',media_id:5,all_seasons:true})).error.code).toBe('INPUT_INVALID');
 expect(calls).toEqual([]);
 await run(request,{media_type:'tv',media_id:5,all_seasons:true});
 await run(request,{media_type:'tv',media_id:5,seasons:[2]});
 await run(request,{media_type:'movie',media_id:603});
 expect(calls).toEqual([['request_create',{mediaType:'tv',mediaId:5,seasons:'all'}],['request_create',{mediaType:'tv',mediaId:5,seasons:[2]}],['request_create',{mediaType:'movie',mediaId:603}]]);
});

it('talks to the real gateway over its Unix socket and reports a missing gateway as unavailable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ms-'));dirs.push(dir);
 const ssh=join(dir,'ssh');await writeFile(ssh,`#!/bin/sh\ncat >/dev/null\necho '{"ok":true,"result":{"services":{"sonarr":{"reachable":true,"issues":[]}}}}'\n`);await chmod(ssh,0o755);
 const socketPath=join(dir,'g.sock');
 const gateway=createGateway({version:1,socketPath,ssh:{host:'100.79.123.105',user:'media-collector',key:join(dir,'k'),knownHosts:join(dir,'h'),binary:ssh}});
 await gateway.listen();closers.push(()=>gateway.close());
 const bundle=createMediaStackBundle(config(socketPath));
 expect(await run(tool(bundle,'media_stack'),{operation:'health'})).toMatchObject({ok:true,result:{services:{sonarr:{reachable:true}}}});
 expect((await run(tool(bundle,'media_request'),{media_type:'movie',media_id:1})).error.code).toBe('REQUESTS_DISABLED');
 expect(await callMediaGateway(join(dir,'missing.sock'),'health',{})).toMatchObject({ok:false,error:{code:'MEDIA_GATEWAY_UNAVAILABLE'}});
});
