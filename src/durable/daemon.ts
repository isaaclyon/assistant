import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindProcessShutdownSignals, createShutdownLatch, SHUTDOWN_DISPOSAL_TIMEOUT_MS } from '../lifecycle.js';
import { createRuntimeMetadata, writeRuntimeMetadata, type BridgeRuntimeStatus } from '../runtime-metadata.js';
import { createNativeApplication } from './application.js';
import { loadNativeConfig, type NativeConfig } from './config.js';

/** Process-level watchdog also covers a tool that never cooperates with cancellation. */
export async function runNativeDaemon(config:NativeConfig):Promise<void> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 let requested=false;
 const exitCode=(reason:string)=>reason==='restart'?75:reason==='fatal'?1:0;
 const latch=createShutdownLatch(reason=>{
  requested=true;
  timer=setTimeout(()=>process.exit(exitCode(reason)),SHUTDOWN_DISPOSAL_TIMEOUT_MS);
 });
 const unbind=bindProcessShutdownSignals(latch);
 const keepAlive=setInterval(()=>{},60_000);
 let application:Awaited<ReturnType<typeof createNativeApplication>>|undefined;
 const status=async(value:BridgeRuntimeStatus)=>writeRuntimeMetadata(config.runtimeMetadataPath,createRuntimeMetadata({instanceId:config.instanceId,releaseSha:config.releaseSha,pid:process.pid,status:value,principal:config.principal,telegramSurface:'private',workspaceCwd:config.workspaceCwd,resourceRoot:config.resourceRoot}));
 try {
  process.chdir(config.workspaceCwd);
  await status('starting');
  application=await createNativeApplication(config,{
   onFatal:()=>{latch.request('fatal');void status('failed').catch(()=>{});},
   // Only fixed diagnostics: network errors may contain token-bearing request URLs.
   onTransportFailure:()=>console.error('Native Telegram transport unavailable; ownership recovery remains active.'),
  });
  if(!requested){await application.start();if(!requested)await status('ready');}
  const reason=await latch.wait();
  await status(reason==='fatal'?'failed':'stopping');
  await application.close();
  process.exitCode=exitCode(reason);
 }catch{
  latch.request('fatal');
  await status('failed').catch(()=>{});
  console.error('Native runtime failed; inspect private recovery state before restarting.');
  if(application){
   try{await application.close();}catch{process.exit(1);}
  }
  process.exitCode=1;
 }finally{
  if(timer)clearTimeout(timer);
  clearInterval(keepAlive);unbind();
 }
}
async function main() {
 process.umask(0o077);
 const path=process.env.PI_DURABLE_CONFIG;
 if(!path)throw new Error('PI_DURABLE_CONFIG must name the private native instance configuration');
 const config=await loadNativeConfig(path);
 const releaseRoot=await realpath(resolve(import.meta.dirname,'../../..'));
 if(config.resourceRoot!==releaseRoot)throw new Error('Native entrypoint and resource release differ');
 const expected=process.env.PI_TELEGRAM_BRIDGE_RELEASE_SHA;
 if(!expected||expected!==config.releaseSha)throw new Error('Explicit native release identity mismatch');
 await runNativeDaemon(config);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error('Native runtime configuration failed.');process.exitCode=1;});
}
