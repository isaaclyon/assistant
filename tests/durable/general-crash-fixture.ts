import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGeneralToolsBundle, createNativeExecutionEnvironment } from '../../src/durable/general-tools.js';
import { loadNativeRegistry, type NativeTool } from '../../src/durable/registry.js';
import { nativeMemoryBinding } from '../../src/durable/authority.js';
import type { NativeConfig } from '../../src/durable/config.js';
import type { DurableHost } from '../../src/durable/host.js';

/** Test-only pause after the real effect, before returning its tool result.
 * The selected production loader owns authorization and recovery signatures. */
export async function generalCrashFixture(path:string,host:()=>DurableHost,afterEffect?:()=>Promise<void>) {
 const config={workspaceCwd:path,resourceRoot:process.cwd(),stateDir:path,instanceId:'test',principal:'isaac',capabilityProfile:'durable-tools-test',memory:{},transport:{allowedUserId:10}} as unknown as NativeConfig;
 const env=createNativeExecutionEnvironment(config);
 const resources=await loadNativeRegistry({resourceRoot:config.resourceRoot,profileId:config.capabilityProfile,
  authorize:async(_name,api,ctx)=>{
   await appendFile(join(path,'authority-checks'),'check\n');
   if(!await api.commit(tx=>nativeMemoryBinding(tx,host(),config,api.conversationId),ctx))throw new Error('Current tool authority rejected');
  },
  bundleContext:{bundle:(name:string)=>{
   if(name!=='general-tools')return {name,version:1,tools:[],close:async()=>{}};
   const bundle=createGeneralToolsBundle();
   return {...bundle,tools:bundle.tools.map(({tool,version}):NativeTool=>({version,tool:{...tool,execute:async(args,api,ctx)=>{
    await appendFile(join(path,'attempts'),'attempt\n');
    const result=await tool.execute(args,api,ctx);
    await afterEffect?.();
    return result;
   }}}))};
  }},
 });
 return {env,...resources};
}
