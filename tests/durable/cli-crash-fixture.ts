import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGeneralToolsBundle, createNativeExecutionEnvironment } from '../../src/durable/general-tools.js';
import { loadNativeRegistry, type NativeTool } from '../../src/durable/registry.js';
import { nativeMemoryBinding } from '../../src/durable/authority.js';
import type { NativeConfig } from '../../src/durable/config.js';
import type { DurableHost } from '../../src/durable/host.js';

/** Synthetic YNAB-style CLI write. The real bash tool runs a fake executable in a
 * disposable HOME; the test pauses after shell success, before the result commits.
 * The production loader selects the profile and authorizes every tool call.
 * No real YNAB, credentials, or network. */
export async function cliCrashFixture(path:string,host:()=>DurableHost,afterEffect?:()=>Promise<void>) {
 const home=join(path,'cli-home'),bin=join(home,'bin');await mkdir(bin,{recursive:true,mode:0o700});
 const executable=join(bin,'fake-ynab');
 await writeFile(executable,`#!/bin/sh\necho effect >> "$HOME/cli-effects"\nprintf '%s' '{"data":{"transaction":{"id":"fictional-transaction"}}}'\n`);await chmod(executable,0o700);
 const command=`HOME='${home}' '${executable}' transactions create --budget fictional --amount -1`;
 const config={workspaceCwd:path,resourceRoot:process.cwd(),stateDir:path,instanceId:'test',principal:'isaac',capabilityProfile:'durable-cli-integrations-test',memory:{},transport:{allowedUserId:10}} as unknown as NativeConfig;
 const env=createNativeExecutionEnvironment(config);
 const resources=await loadNativeRegistry({resourceRoot:config.resourceRoot,profileId:config.capabilityProfile,
  authorize:async(_name,api,ctx)=>{
   await appendFile(join(path,'authority-checks'),'check\n');
   if(!await api.commit(tx=>nativeMemoryBinding(tx,host(),config,api.conversationId),ctx))throw new Error('Current tool authority rejected');
  },
  bundleContext:{bundle:(name:string)=>{
   if(name!=='general-tools')return {name,version:1,tools:[],close:async()=>{}};
   const bundle=createGeneralToolsBundle();
   return {...bundle,tools:bundle.tools.map(({tool,version}):NativeTool=>tool.name!=='bash'?{version,tool}:({version,tool:{...tool,execute:async(args,api,ctx)=>{
    await appendFile(join(path,'attempts'),'attempt\n');
    const result=await tool.execute(args,api,ctx);
    await afterEffect?.();
    return result;
   }}}))};
  }},
 });
 return {env,command,effects:join(home,'cli-effects'),...resources};
}
