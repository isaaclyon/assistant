import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,test,vi} from 'vitest';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import type {NativeConfig} from '../../src/durable/config.js';
import {createNativeBrowser} from '../../src/durable/browser.js';
import {bindNativeBrowserEnvironment} from '../../src/durable/browser-environment.js';
import {validateRuntimeMiniAppIdentity} from '../../src/runtime-telegram-transport.js';

test('broker browser requests stay on the selected socket and expose only nonsecret candidate fields',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'native-browser-broker-')),socketPath=join(directory,'broker.sock');
 await mkdir(join(directory,'agent'));await writeFile(join(directory,'agent/telegram.json'),JSON.stringify({profiles:{test:{botToken:'123:runtime',allowedUserId:42}}}),{mode:0o600});
 const calls:{path:string;body:any}[]=[];
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));calls.push({path:req.url!,body:JSON.parse(Buffer.concat(chunks).toString())});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/credentialCandidates'?{ok:true,candidates:[{reference:`source:${'a'.repeat(26)}`,title:'Example',password:'fictional-secret'}],token:'fictional-secret'}:{ok:true,result:true}));});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const config={capabilityProfile:'durable-browser-test',instanceId:'test',principal:'isaac',resourceRoot:'/release',stateDir:directory,google:{},transport:{mode:'broker',socketPath,botId:123,allowedUserId:42},browser:{agentDir:join(directory,'agent'),telegramProfile:'test',credentialScope:'test',configRoot:directory,runtimeDir:directory,dataDir:directory,endpoints:{bindAddress:'10.20.30.2',inputOrigin:'https://test.synthetic.ts.net:8446',takeoverOrigin:'https://test.synthetic.ts.net:8447'}}} as NativeConfig;
 const restore=bindNativeBrowserEnvironment(config),direct=vi.fn(()=>{throw new Error('Direct fetch forbidden');});vi.stubGlobal('fetch',direct);
 const browser=createNativeBrowser(config);
 try{
  const tool=browser.bundle().tools.find(t=>t.tool.name==='find_login_candidates')!.tool;
  const result=await tool.execute({origin:'https://example.test'},{} as never,BACKGROUND_CONTEXT);
  expect(JSON.parse((result.output![0] as any).text)).toEqual({ok:true,candidates:[{reference:`source:${'a'.repeat(26)}`,title:'Example'}]});
  expect(await validateRuntimeMiniAppIdentity('fictional-signed-input','123:runtime',42,Date.now())).toBe(true);
  expect(calls.map(c=>c.path)).toEqual(['/api/credentialCandidates','/api/verifyMiniAppIdentity']);
  expect(direct).not.toHaveBeenCalled();
  // Losing the broker cannot change the selected transport to direct Bot API.
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  const unavailable=await tool.execute({origin:'https://example.test'},{} as never,BACKGROUND_CONTEXT);
  expect(JSON.parse((unavailable.output![0] as any).text)).toEqual({status:'unavailable'});expect(direct).not.toHaveBeenCalled();
 }finally{await browser.close();restore();vi.unstubAllGlobals();server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
