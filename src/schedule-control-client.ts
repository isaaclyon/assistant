import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface ScheduleClientConfig { socketPath:string; serverUid:number; keyFile:string }
export const SCHEDULE_REQUEST_LIMIT=64*1024;
export const SCHEDULE_RESPONSE_LIMIT=256*1024;
export function parseScheduleClient(value:unknown):ScheduleClientConfig {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid schedule client');
 const c=value as Record<string,unknown>;
 if(Object.keys(c).some(k=>!['socketPath','serverUid','keyFile'].includes(k))||
  typeof c.socketPath!=='string'||!isAbsolute(c.socketPath)||Buffer.byteLength(c.socketPath)>100||
  typeof c.keyFile!=='string'||!isAbsolute(c.keyFile)||!Number.isSafeInteger(c.serverUid)||Number(c.serverUid)<0)throw new Error('Invalid schedule client');
 return c as unknown as ScheduleClientConfig;
}
/** Both sides hold separate private copies; file contents never enter tool results. */
export async function readScheduleKey(path:string):Promise<string> {
 if(await realpath(path)!==resolve(path))throw new Error('Unsafe schedule key');
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const s=await f.stat();
  if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.uid!==process.getuid?.()||s.size>128)throw new Error('Unsafe schedule key');
  const key=(await f.readFile('utf8')).trim();if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid schedule key');return key;
 }finally{await f.close();}
}
export async function assertScheduleSocketDirectory(socketPath:string,uid:number):Promise<void>{
 const parent=dirname(socketPath),s=await lstat(parent);
 if(!s.isDirectory()||s.uid!==uid||(s.mode&0o022)!==0||await realpath(parent)!==resolve(parent))throw new Error('Unsafe schedule socket directory');
}
export async function forwardScheduleRequest(input:Record<string,unknown>,serialized:string):Promise<Record<string,unknown>> {
 // No network fallback, retries, redirects, ambient coordinator discovery or request-selected endpoint.
 const config=parseScheduleClient(JSON.parse(serialized));
 const body=JSON.stringify(input);if(Buffer.byteLength(body)>SCHEDULE_REQUEST_LIMIT)throw new Error('Schedule request is too large');
 await assertScheduleSocketDirectory(config.socketPath,config.serverUid);
 const socket=await lstat(config.socketPath);
 if(!socket.isSocket()||socket.uid!==config.serverUid||(socket.mode&0o007)!==0)throw new Error('Unsafe schedule control socket');
 const key=await readScheduleKey(config.keyFile);
 return new Promise((resolve,reject)=>{
  const fail=()=>reject(new Error('Schedule control outcome unknown; inspect the job before retrying.'));
  const request=httpRequest({socketPath:config.socketPath,path:'/v1/schedules',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','content-length':Buffer.byteLength(body)},agent:false},response=>{
   const chunks:Buffer[]=[];let size=0;
   response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>SCHEDULE_RESPONSE_LIMIT){request.destroy();fail();}else chunks.push(chunk);});
   response.on('error',fail);
   response.on('end',()=>{
    try{
     const result=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
     if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.ok!=='boolean')throw new Error();
     resolve(result);
    }catch{fail();}
   });
  });
  const timer=setTimeout(()=>{request.destroy();fail();},12_000);timer.unref();
  request.on('error',fail);request.on('close',()=>clearTimeout(timer));request.end(body);
 });
}
