import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,writeFile,readFile,chmod} from 'node:fs/promises';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {createGateway,parseRequest,validateGatewayConfig}=await import(new URL('../../scripts/media-gateway.mjs',import.meta.url).href);
const dirs:string[]=[];const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0))await close();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function setup(reply:string,overrides:Record<string,unknown>={},timeoutMs=5000){
 const dir=await mkdtemp(join(tmpdir(),'mg-'));dirs.push(dir);
 const ssh=join(dir,'ssh');
 // Fake ssh records its arguments and stdin, then prints the configured reply.
 await writeFile(ssh,`#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ncat > '${dir}/stdin'\n${reply}\n`);await chmod(ssh,0o755);
 const config={version:1,socketPath:join(dir,'s.sock'),ssh:{host:'100.79.123.105',user:'media-collector',key:join(dir,'key'),knownHosts:join(dir,'known'),binary:ssh},...overrides};
 const gateway=createGateway(config,{timeoutMs});await gateway.listen();closers.push(()=>gateway.close());
 const ask=(line:string)=>new Promise<any>((resolve,reject)=>{const socket=connect(config.socketPath);let data='';socket.on('data',c=>{data+=c;});socket.on('end',()=>resolve(JSON.parse(data)));socket.on('error',reject);socket.write(line);});
 return {dir,ask,config};
}
const send=(op:string,args:unknown={})=>JSON.stringify({op,args})+'\n';

it('forwards a typed read over pinned, agentless SSH and returns the collector reply',async()=>{
 const {dir,ask}=await setup(`echo '{"ok":true,"result":{"services":{}}}'`);
 expect(await ask(send('health'))).toEqual({ok:true,result:{services:{}}});
 const args=(await readFile(join(dir,'args'),'utf8')).split('\n');
 expect(args).toEqual(expect.arrayContaining(['-F','/dev/null','BatchMode=yes','IdentitiesOnly=yes','IdentityAgent=none','StrictHostKeyChecking=yes',`UserKnownHostsFile=${join(dir,'known')}`,'ClearAllForwardings=yes','media-collector@100.79.123.105']));
 expect(JSON.parse(await readFile(join(dir,'stdin'),'utf8'))).toEqual({op:'health',args:{}});
});

it('blocks request creation unless the operator enabled it, and rejects unknown or malformed input before SSH',async()=>{
 const off=await setup(`echo '{"ok":true,"result":{}}'`);
 expect((await off.ask(send('request_create',{mediaType:'movie',mediaId:1}))).error.code).toBe('REQUESTS_DISABLED');
 expect((await off.ask(send('docker_exec'))).error.code).toBe('OPERATION_UNKNOWN');
 expect((await off.ask('not json\n')).error.code).toBe('INPUT_INVALID');
 expect((await off.ask(JSON.stringify({op:'health',host:'evil'})+'\n')).error.code).toBe('INPUT_INVALID');
 expect((await off.ask('x'.repeat(3000))).error.code).toBe('INPUT_INVALID');
 await expect(readFile(join(off.dir,'args'),'utf8')).rejects.toThrow();
 const on=await setup(`echo '{"ok":true,"result":{"requestId":1}}'`,{allowRequests:true});
 expect((await on.ask(send('request_create',{mediaType:'movie',mediaId:1}))).ok).toBe(true);
});

it('reports an unreachable, garbled or slow host without leaking output or retrying',async()=>{
 expect((await (await setup('echo "Permission denied (publickey)"; exit 255')).ask(send('queue'))).error.code).toBe('MEDIA_UNAVAILABLE');
 const slow=await setup('sleep 5',{},300);
 expect((await slow.ask(send('queue'))).error.code).toBe('MEDIA_TIMEOUT');
 const big=await setup('head -c 300000 /dev/zero | tr "\\\\0" a');
 expect((await big.ask(send('queue'))).error.code).toBe('MEDIA_RESPONSE_TOO_LARGE');
 const busy=await setup('sleep 1; echo \'{"ok":true,"result":{}}\'',{maxConcurrent:1});
 const [first,second]=await Promise.all([busy.ask(send('queue')),new Promise(r=>setTimeout(r,150)).then(()=>busy.ask(send('queue')))]);
 expect(first.ok).toBe(true);expect(second.error.code).toBe('MEDIA_BUSY');
});

it('requires a literal IP, absolute paths and bounded options',()=>{
 const good={version:1,socketPath:'/run/m.sock',ssh:{host:'100.79.123.105',user:'media-collector',key:'/k',knownHosts:'/h'}};
 expect(validateGatewayConfig(good).allowRequests).toBe(false);
 for(const patch of [{ssh:{...good.ssh,host:'lyon-media.ts.net'}},{ssh:{...good.ssh,host:'300.1.1.1'}},{ssh:{...good.ssh,key:'k'}},{socketPath:'m.sock'},{socketMode:0o666},{maxConcurrent:9},{version:2}])
  expect(()=>validateGatewayConfig({...good,...patch})).toThrow(/Invalid media gateway/);
 expect(parseRequest('[]',true)).toMatchObject({ok:false});
});
