import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface NativeConfig {
 version: 1; runtime: 'pi-durable'; instanceId: string; principal: 'isaac'|'emma'|'household'|'engineering';
 releaseSha: string; resourceRoot: string; workspaceCwd: string; stateDir: string;
 capabilityProfile: string; account: string; credentialPath: string; settingsPath: string; jobsRole: 'disabled'; idleHours: number;
 transport: { mode:'ordinary'; profile:string; configPath:string; locksPath:string; botId:number; allowedUserId:number }
   | { mode:'broker'; socketPath:string; botId:number; allowedUserId:number };
 historyDir: string; inboxPath: string; runtimeMetadataPath: string;
}
const record=(value:unknown,label:string):Record<string,unknown>=>{
 if(!value || typeof value!=='object'||Array.isArray(value)) throw new Error(`${label} must be an object`);
 return value as Record<string,unknown>;
};
function fields(value:Record<string,unknown>,allowed:string[],label:string) {
 if(Object.keys(value).some(key=>!allowed.includes(key))) throw new Error(`${label} has an unknown field`);
}
function text(value:unknown,label:string,pattern?:RegExp):string {
 if(typeof value!=='string'||!value.trim()||(pattern&&!pattern.test(value))) throw new Error(`Invalid ${label}`);
 return value;
}
function absolute(value:unknown,label:string):string {
 const result=text(value,label); if(!isAbsolute(result)) throw new Error(`${label} must be absolute`); return result;
}
function positive(value:unknown,label:string):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0) throw new Error(`Invalid ${label}`); return value;
}
function contains(parent:string,child:string):boolean {
 const path=relative(parent,child); return path===''||(!path.startsWith(`..${sep}`)&&path!=='..'&&!isAbsolute(path));
}
/** Explicit operator configuration; secrets remain in their existing scoped files. */
export async function loadNativeConfig(path:string):Promise<NativeConfig> {
 absolute(path,'configuration path');
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Configuration must be a regular file');
 if((stat.mode&0o077)!==0 || (process.getuid && stat.uid!==process.getuid())) throw new Error('Configuration must be private and owned by this runtime');
 let raw:unknown; try{raw=JSON.parse(await readFile(path,'utf8'));}catch{throw new Error('Invalid native configuration JSON');}
 const value=record(raw,'Native configuration');
 fields(value,['version','runtime','instanceId','principal','releaseSha','resourceRoot','workspaceCwd','stateDir','capabilityProfile','account','credentialPath','settingsPath','jobsRole','idleHours','transport'],'Native configuration');
 if(value.version!==1||value.runtime!=='pi-durable') throw new Error('Unsupported native runtime or configuration version');
 if(value.jobsRole!=='disabled') throw new Error('C2 requires jobsRole disabled');
 const idleHours=value.idleHours??0;
 if(typeof idleHours!=='number'||!Number.isFinite(idleHours)||idleHours<0||idleHours>8760)throw new Error('Invalid idleHours');
 const principal=text(value.principal,'principal');
 if(!['isaac','emma','household','engineering'].includes(principal)) throw new Error('Invalid principal');
 const capabilityProfile=text(value.capabilityProfile,'capability profile');
 if(!['durable-foundation-test','durable-chat-memory-test'].includes(capabilityProfile)) throw new Error('Unsupported native capability profile');
 const resourceRoot=await realpath(absolute(value.resourceRoot,'resourceRoot'));
 const workspaceCwd=await realpath(absolute(value.workspaceCwd,'workspaceCwd'));
 const stateDir=await realpath(absolute(value.stateDir,'stateDir'));
 if(contains(resourceRoot,stateDir)||contains(stateDir,resourceRoot)||contains(stateDir,workspaceCwd)||contains(workspaceCwd,stateDir)) throw new Error('Native state, release and workspace roots must not overlap');
 const stateStat=await lstat(stateDir);
 if(!stateStat.isDirectory() || (stateStat.mode&0o077)!==0 || (process.getuid && stateStat.uid!==process.getuid())) throw new Error('Native state directory must be private and owned by this runtime');
 const rawTransport=record(value.transport,'transport');
 const botId=positive(rawTransport.botId,'botId'), allowedUserId=positive(rawTransport.allowedUserId,'allowedUserId');
 let transport:NativeConfig['transport'];
 if(rawTransport.mode==='broker') {
  fields(rawTransport,['mode','socketPath','botId','allowedUserId'],'Broker transport');
  transport={mode:'broker',socketPath:absolute(rawTransport.socketPath,'socketPath'),botId,allowedUserId};
 } else if(rawTransport.mode==='ordinary') {
  fields(rawTransport,['mode','profile','configPath','locksPath','botId','allowedUserId'],'Ordinary transport');
  transport={mode:'ordinary',profile:text(rawTransport.profile,'profile',/^[a-z0-9-]+$/),configPath:absolute(rawTransport.configPath,'configPath'),locksPath:absolute(rawTransport.locksPath,'locksPath'),botId,allowedUserId};
 } else throw new Error('Unsupported transport mode');
 return {version:1,runtime:'pi-durable',instanceId:text(value.instanceId,'instanceId',/^[a-z0-9][a-z0-9-]{0,63}$/),principal:principal as NativeConfig['principal'],releaseSha:text(value.releaseSha,'releaseSha',/^[a-f0-9]{40}$/),resourceRoot,workspaceCwd,stateDir,capabilityProfile,account:text(value.account,'account',/^[a-zA-Z0-9._-]{1,128}$/),credentialPath:absolute(value.credentialPath,'credentialPath'),settingsPath:absolute(value.settingsPath,'settingsPath'),jobsRole:'disabled',idleHours,transport,historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json')};
}
