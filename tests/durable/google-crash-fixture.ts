import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGoogleReadBundle } from '../../src/durable/google-read.js';
import { createNativeExecutionEnvironment } from '../../src/durable/general-tools.js';
import { loadNativeRegistry, type NativeTool } from '../../src/durable/registry.js';
import { nativeMemoryBinding } from '../../src/durable/authority.js';
import type { NativeConfig } from '../../src/durable/config.js';
import type { DurableHost } from '../../src/durable/host.js';

/** Test-only pause after the real google_workspace tool finishes its synthetic
 * gog child, before the tool result returns. Production loader and authority
 * select and authorize the tool; no real Google credentials or network. */
export async function googleCrashFixture(path:string,host:()=>DurableHost,afterEffect?:()=>Promise<void>,kind:'account'|'places'='account') {
 const home=join(path,'gog-home');await mkdir(home,{recursive:true,mode:0o700});
 const binary=join(path,'fake-gog'),passwordFile=join(path,'fake-gog-password');
 await writeFile(binary,`#!/bin/sh\necho child >> '${join(path,'gog-children')}'\nprintf '%s' '{"accounts":[{"email":"fictional@example.test","services":["gmail"],"scopes":[]}]}'\n`);await chmod(binary,0o700);
 await writeFile(passwordFile,'fictional-password',{mode:0o600});await chmod(passwordFile,0o600);
 const config={workspaceCwd:path,resourceRoot:process.cwd(),stateDir:path,instanceId:'test',principal:'isaac',capabilityProfile:'durable-read-integrations-test',memory:{},
  google:{account:'fictional@example.test',gog:{binary,passwordFile,home},places:{apiKeyFile:join(path,'unused-places-key'),searchMonthlyLimit:10,detailsMonthlyLimit:10,candidatesMonthlyLimit:10}},transport:{allowedUserId:10}} as unknown as NativeConfig;
 const env=createNativeExecutionEnvironment(config);
 const resources=await loadNativeRegistry({resourceRoot:config.resourceRoot,profileId:config.capabilityProfile,
  authorize:async(_name,api,ctx)=>{
   await appendFile(join(path,'authority-checks'),'check\n');
   if(!await api.commit(tx=>nativeMemoryBinding(tx,host(),config,api.conversationId),ctx))throw new Error('Current tool authority rejected');
  },
  bundleContext:{bundle:(name:string)=>{
   if(name!=='google-reads')return {name,version:1,tools:[],close:async()=>{}};
   // Places mode injects a synthetic fetch (real cache/meter/gateway) and pauses
   // in the nested unsafe google_places_read handler, after the outbound effect.
   const bundle=createGoogleReadBundle(config,kind==='places'?{fetchPlaceSearch:async()=>{
    await appendFile(join(path,'places-fetches'),'fetch\n');
    return {places:[{id:'fictional_place',displayName:{text:'Fictional Cafe'},formattedAddress:'1 Test Way',googleMapsUri:'https://maps.example.test/p'}]};
   }}:{});
   const paused=kind==='places'?'google_places_read':'google_workspace';
   return {...bundle,tools:bundle.tools.map(({tool,version}):NativeTool=>tool.name!==paused?{version,tool}:({version,tool:{...tool,execute:async(args,api,ctx)=>{
    await appendFile(join(path,'attempts'),'attempt\n');
    const result=await tool.execute(args,api,ctx);
    await afterEffect?.();
    return result;
   }}}))};
  }},
 });
 return {env,...resources};
}
