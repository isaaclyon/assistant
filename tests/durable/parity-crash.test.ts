import { fork,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp,mkdir,mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll,afterEach,beforeAll,expect,test,vi } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { setup,fictionalWebAuth,cleanup } from './parity-application-fixture.js';
let compiled:string;
beforeAll(async()=>{
 const cache=join(process.cwd(),'node_modules/.cache');await mkdir(cache,{recursive:true});compiled=await mkdtemp(join(cache,'parity-crash-'));
 await promisify(execFile)(process.execPath,['node_modules/typescript/bin/tsc','--strict','--skipLibCheck','--allowJs','--module','nodenext','--target','es2024','--rootDir','.','--outDir',compiled,'tests/durable/parity-application-fixture.ts'],{timeout:90_000});
 await cp(join(process.cwd(),'.pi'),join(compiled,'.pi'),{recursive:true,filter:source=>!source.endsWith('.ts')});
},100_000);
afterAll(async()=>{if(compiled)await rm(compiled,{recursive:true,force:true});});
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});

test.each(['before','after'])('SIGKILL %s hosted web effect never repeats the unsafe request or its accepted source',async phase=>{
 const directory=await mkdtemp(join(tmpdir(),'native-web-crash-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const child=fork(join(process.cwd(),'tests/durable/parity-crash-worker.mjs'),[compiled,directory,phase],{stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr!.on('data',chunk=>stderr+=String(chunk));
 const paused=Promise.withResolvers<void>();child.on('message',(m:any)=>{if(m.type==='paused')paused.resolve();});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{if(signal!=='SIGKILL')paused.reject(new Error(`Early worker exit ${code}: ${stderr}`));resolve(signal);}));
 cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
 await Promise.race([paused.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`Worker IPC timeout: ${stderr}`)),10_000);timer.unref();paused.promise.finally(()=>clearTimeout(timer)).catch(()=>{});})]);
 child.kill('SIGKILL');expect(await exited).toBe('SIGKILL');
 expect(await readFile(join(directory,'hosted-attempts'),'utf8')).toBe('attempt\n');
 const s=await setup('durable-parity-test',directory);let reissued=0;const recovered:string[]=[];
 await s.open([(request:any)=>{recovered.push(JSON.stringify(request.messages.filter((m:any)=>m.role==='toolResult')));return fauxAssistantMessage('RECOVERED');}],false,{webRunFetch:async()=>{reissued++;throw new Error('Must not replay');}},fictionalWebAuth);
 await vi.waitFor(()=>expect(s.finals).toEqual(['RECOVERED']),{timeout:8000});
 expect(recovered.join('')).toMatch(/interrupt|uncertain|may or may not/i);expect(reissued).toBe(0);
 await s.accept('Read a hosted public page.',undefined,42,1);await s.app()!.host.reconcile();expect(reissued).toBe(0);
 expect(await readFile(join(directory,'hosted-attempts'),'utf8')).toBe('attempt\n');
 const effects=await readFile(join(directory,'hosted-effects'),'utf8').catch(()=> '');expect(effects).toBe(phase==='after'?'effect\n':'');
 expect(s.fatal).toHaveLength(0);
},30_000);
