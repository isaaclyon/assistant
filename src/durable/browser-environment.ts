import type { NativeConfig } from './config.js';

let owner: symbol | undefined;
/** The retained Chrome helpers use process-scoped paths. One native instance owns
 * them for its entire lifetime; restore only after its protected work drains. */
export function nativeBrowserEnvironment(config:NativeConfig):Record<string,string|undefined> {
 const browser=config.browser;if(!browser)throw new Error('Explicit browser configuration required');
 return {
  PI_TELEGRAM_BRIDGE_INSTANCE_ID:config.instanceId,
  PI_TELEGRAM_BRIDGE_RESOURCE_ROOT:config.resourceRoot,
  PI_TELEGRAM_BRIDGE_STATE_DIR:config.stateDir,
  PI_TELEGRAM_BRIDGE_CONFIG_ROOT:browser.configRoot,
  PI_TELEGRAM_CREDENTIAL_SCOPE:browser.credentialScope,
  XDG_RUNTIME_DIR:browser.runtimeDir,XDG_DATA_HOME:browser.dataDir,
  PI_TELEGRAM_TRUSTED_SOCKET:config.transport.mode==='broker'?config.transport.socketPath:undefined,
  PI_PRIVATE_BROWSER_BIND_ADDRESS:browser.endpoints?.bindAddress,
  PI_PRIVATE_INPUT_ORIGIN:browser.endpoints?.inputOrigin,
  PI_PRIVATE_TAKEOVER_ORIGIN:browser.endpoints?.takeoverOrigin,
 };
}
export function bindNativeBrowserEnvironment(config:NativeConfig):()=>void {
 if(owner)throw new Error('A native browser instance already owns this process');
 const selection=nativeBrowserEnvironment(config),previous=new Map<string,string|undefined>();
 const token=Symbol();owner=token;
 for(const [key,value] of Object.entries(selection)){
  previous.set(key,process.env[key]);if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
 return ()=>{if(owner!==token)return;for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}owner=undefined;};
}

/** Covers the full authorized invocation, including in-memory work already in
 * flight. A browser operation cannot race a read that started before its gate. */
export function createNativeBrowserGate(protectedToolNames: Iterable<string>) {
 let ordinary=0,protectedActive=false;
 const names=new Set(protectedToolNames);
 return {
  async run<T>(name:string,work:()=>Promise<T>):Promise<T>{
   const protectedCall=names.has(name);
   if(protectedActive||(protectedCall&&ordinary>0))throw new Error('Private browser operation is active or other tools are still running. Wait for completion.');
   if(protectedCall)protectedActive=true;else ordinary++;
   try{return await work();}finally{if(protectedCall)protectedActive=false;else ordinary--;}
  },
 };
}
