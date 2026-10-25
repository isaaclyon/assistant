import { expect,test,vi,afterEach } from 'vitest';
import { bindNativeBrowserEnvironment,createNativeBrowserGate,nativeBrowserEnvironment } from '../../src/durable/browser-environment.js';
import { browserOutcome } from '../../src/durable/browser.js';
import type { NativeConfig } from '../../src/durable/config.js';
afterEach(()=>vi.unstubAllEnvs());
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
const config={instanceId:'synthetic',resourceRoot:'/release',stateDir:'/state',browser:{agentDir:'/agent',telegramProfile:'private',credentialScope:'synthetic',configRoot:'/config',runtimeDir:'/runtime',dataDir:'/data'},transport:{mode:'ordinary'}} as NativeConfig;
test('private entry excludes every tool until all cleanup has returned',async()=>{
 const gate=createNativeBrowserGate(['renamed_browser_tool']),cleanup=deferred(),started=deferred();
 const privateWork=gate.run('renamed_browser_tool',async()=>{started.resolve();await cleanup.promise;return 'done';});await started.promise;
 for(const name of ['read','bash','write','assistant_memory','google_workspace','browser_takeover','find_login_candidates']){
  const work=vi.fn(async()=>{});await expect(gate.run(name,work)).rejects.toThrow(/Private browser/);expect(work).not.toHaveBeenCalled();
 }
 cleanup.resolve();await expect(privateWork).resolves.toBe('done');
 await expect(gate.run('read',async()=>42)).resolves.toBe(42);
});
test('an ordinary tool already in flight prevents browser entry without waiting or racing',async()=>{
 const gate=createNativeBrowserGate(['private_browser_input','browser_takeover']),hold=deferred(),started=deferred();
 const work=gate.run('read',async()=>{started.resolve();await hold.promise;});await started.promise;
 const browser=vi.fn(async()=>{});await expect(gate.run('private_browser_input',browser)).rejects.toThrow(/still running/);expect(browser).not.toHaveBeenCalled();
 hold.resolve();await work;await gate.run('private_browser_input',browser);expect(browser).toHaveBeenCalledOnce();
 await expect(gate.run('browser_takeover',async()=>{throw new Error('fixed failure');})).rejects.toThrow('fixed failure');
 await expect(gate.run('read',async()=>true)).resolves.toBe(true);
});
test('native browser paths and broker ownership replace ambient settings for one process lifetime',()=>{
 vi.stubEnv('PI_TELEGRAM_TRUSTED_SOCKET','/ambient-broker');vi.stubEnv('XDG_RUNTIME_DIR','/ambient-runtime');vi.stubEnv('PI_PRIVATE_INPUT_ORIGIN','https://ambient.invalid');
 const restore=bindNativeBrowserEnvironment(config);
 try{
  expect(process.env.PI_TELEGRAM_TRUSTED_SOCKET).toBeUndefined();expect(process.env.PI_PRIVATE_INPUT_ORIGIN).toBeUndefined();expect(process.env.XDG_RUNTIME_DIR).toBe('/runtime');
  expect(()=>bindNativeBrowserEnvironment(config)).toThrow(/already owns/);
  expect(nativeBrowserEnvironment({...config,transport:{mode:'broker',socketPath:'/selected-broker',botId:1,allowedUserId:2}}).PI_TELEGRAM_TRUSTED_SOCKET).toBe('/selected-broker');
 }finally{restore();restore();}
 expect(process.env.PI_TELEGRAM_TRUSTED_SOCKET).toBe('/ambient-broker');expect(process.env.XDG_RUNTIME_DIR).toBe('/ambient-runtime');
 const another=bindNativeBrowserEnvironment(config);another();
});
test('browser status boundary drops all added data and preserves independent copy receipts',()=>{
 const copy='a'.repeat(26);
 expect(browserOutcome({status:'cancelled',mode:'private',copiedCredentialItem:copy,credentialCopyStatus:'unknown',password:'synthetic-secret',page:'synthetic-page'})).toEqual({status:'cancelled',mode:'private',copiedCredentialItem:copy,credentialCopyStatus:'unknown'});
 expect(browserOutcome({status:'synthetic-secret'})).toEqual({status:'unavailable'});
});

test('browser outcome returns only the fixed unsupported-form reason',()=>{
 expect(browserOutcome({status:'unavailable',loginFailure:'unsupported_form',page:'synthetic-page'})).toEqual({status:'unavailable',loginFailure:'unsupported_form'});
 expect(browserOutcome({status:'unavailable',loginFailure:'synthetic-private-detail'})).toEqual({status:'unavailable'});
});
