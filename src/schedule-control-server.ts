import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import { applyJobsRequest, type ScheduleScope } from './jobs-cli.js';
import { assertScheduleSocketDirectory, readScheduleKey, SCHEDULE_REQUEST_LIMIT, SCHEDULE_RESPONSE_LIMIT } from './schedule-control-client.js';

export interface ScheduleControlGrant extends ScheduleScope { keyFile:string }
export interface ScheduleControlConfig { socketPath:string; grants:ScheduleControlGrant[] }
/** Grants are private host configuration. No client can choose its own authority. */
export function parseScheduleControl(value:unknown,targets:readonly string[]):ScheduleControlConfig{
 const object=(v:unknown)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid schedule control configuration');return v as Record<string,unknown>;};
 const c=object(value);
 if(Object.keys(c).some(k=>!['socketPath','grants'].includes(k))||typeof c.socketPath!=='string'||!isAbsolute(c.socketPath)||Buffer.byteLength(c.socketPath)>100||!Array.isArray(c.grants)||!c.grants.length||c.grants.length>16)throw new Error('Invalid schedule control configuration');
 const grants=c.grants.map(raw=>{
  const g=object(raw);
  if(Object.keys(g).some(k=>!['keyFile','jobPrefix','targets'].includes(k))||typeof g.keyFile!=='string'||!isAbsolute(g.keyFile)||typeof g.jobPrefix!=='string'||! /^[a-z0-9][a-z0-9-]{0,30}-$/.test(g.jobPrefix)||!Array.isArray(g.targets)||!g.targets.length||new Set(g.targets).size!==g.targets.length||g.targets.some(t=>typeof t!=='string'||!targets.includes(t)||t==='both-personal'))throw new Error('Invalid schedule control grant');
  return g as unknown as ScheduleControlGrant;
 });
 for(let i=0;i<grants.length;i++)for(let j=0;j<i;j++)if(grants[i]!.jobPrefix.startsWith(grants[j]!.jobPrefix)||grants[j]!.jobPrefix.startsWith(grants[i]!.jobPrefix))throw new Error('Schedule control grant prefixes overlap');
 return {socketPath:c.socketPath,grants};
}
async function removeStaleSocket(path:string):Promise<void>{
 let meta;try{meta=await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 if(!meta.isSocket()||meta.uid!==process.getuid?.())throw new Error('Unsafe existing schedule socket');
 await new Promise<void>((resolve,reject)=>{
  const probe=connect(path);const timer=setTimeout(()=>{probe.destroy();reject(new Error('Schedule socket ownership is uncertain'));},1000);
  probe.once('connect',()=>{clearTimeout(timer);probe.destroy();reject(new Error('Schedule socket is already listening'));});
  probe.once('error',e=>{clearTimeout(timer);if((e as NodeJS.ErrnoException).code==='ECONNREFUSED')resolve();else reject(new Error('Schedule socket ownership is uncertain'));});
 });
 const current=await lstat(path);if(current.ino!==meta.ino||current.dev!==meta.dev)throw new Error('Schedule socket changed');
 await unlink(path);
}
/** Called only while the native coordinator's lifetime lease is held. */
export async function startScheduleControl(config:ScheduleControlConfig,stateDir:string):Promise<{close():Promise<void>}>{
 await assertScheduleSocketDirectory(config.socketPath,process.getuid!());
 const grants=await Promise.all(config.grants.map(async grant=>({grant,digest:createHash('sha256').update(await readScheduleKey(grant.keyFile)).digest()})));
 if(new Set(grants.map(g=>g.digest.toString('hex'))).size!==grants.length)throw new Error('Schedule control keys must be distinct');
 await removeStaleSocket(config.socketPath);
 let active=0;let closing=false;
 const server:Server=createServer({requestTimeout:10_000,headersTimeout:5_000,maxHeaderSize:2048},async(req,res)=>{
  const reply=(status:number,result:unknown)=>{const raw=JSON.stringify(result);if(Buffer.byteLength(raw)>SCHEDULE_RESPONSE_LIMIT){res.writeHead(413,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'Response too large; inspect a single job.'}));}else{res.writeHead(status,{'content-type':'application/json'});res.end(raw);}};
  const deny=()=>reply(403,{ok:false,error:'Schedule control request denied.'});
  if(req.method!=='POST'||req.url!=='/v1/schedules'||closing){deny();return;}
  const auth=req.headers.authorization;
  if(typeof auth!=='string'||!/^Bearer [a-f0-9]{64}$/.test(auth)){deny();return;}
  const digest=createHash('sha256').update(auth.slice(7)).digest();
  const selected=grants.find(g=>timingSafeEqual(g.digest,digest));
  if(!selected){deny();return;}
  if(active>=8){reply(503,{ok:false,error:'Schedule control busy; no request admitted.'});return;}
  active++;
  try{
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>SCHEDULE_REQUEST_LIMIT)throw new Error('Request too large');chunks.push(Buffer.from(chunk));}
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
   const result=await applyJobsRequest(input,{stateDir,env:{},scope:selected.grant});
   reply(200,result);
  }catch{
   // Domain exceptions may contain another job's prompt, a path or a provider payload.
   reply(400,{ok:false,error:'Schedule request failed or conflicted; inspect the job before retrying.'});
  }finally{active--;}
 });
 server.on('clientError',(_error,socket)=>socket.destroy());
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.socketPath,()=>{server.off('error',reject);resolve();});});
 const identity=await lstat(config.socketPath);
 try{await chmod(config.socketPath,0o660);}catch(e){await new Promise<void>(resolve=>server.close(()=>resolve()));throw e;}
 let stop:Promise<void>|undefined;
 return {close:()=>stop??=(async()=>{
  closing=true;
  await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();});
  // Node normally removes its Unix socket. Do not unlink a replacement.
  const current=await lstat(config.socketPath).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;});
  if(current&&current.ino===identity.ino&&current.dev===identity.dev)await unlink(config.socketPath);
 })()};
}
