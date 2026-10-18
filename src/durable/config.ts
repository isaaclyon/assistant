import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface NativeMemoryConfig {
 vaultRoot: string;
 gitAutocommit: boolean;
 legacySessionRoots: string[];
 timeZone: string;
 recall: 'jev' | 'off';
 semantic: 'on' | 'off';
 judgeKeyFile?: string;
 embeddingKeyFile?: string;
}
export const isNativeMemoryProfile=(profile:string)=>['durable-chat-memory-test','durable-tools-test','durable-read-integrations-test'].includes(profile);
export interface NativeGoogleConfig {
 account?:string;
 gog?:{binary:string;passwordFile:string;home:string};
 places?:{apiKeyFile:string;searchMonthlyLimit:number;detailsMonthlyLimit:number;candidatesMonthlyLimit:number};
 calendarTargets?:{account:string;personal:string;thingsToDo:string};
}
export interface NativeConfig {
 version: 1; runtime: 'pi-durable'; instanceId: string; principal: 'isaac'|'emma'|'household'|'engineering';
 releaseSha: string; resourceRoot: string; workspaceCwd: string; stateDir: string;
 capabilityProfile: string; account: string; credentialPath: string; settingsPath: string; jobsRole: 'disabled'; idleHours: number;
 transport: { mode:'ordinary'; profile:string; configPath:string; locksPath:string; botId:number; allowedUserId:number }
   | { mode:'broker'; socketPath:string; botId:number; allowedUserId:number };
 memory?: NativeMemoryConfig;
 google?: NativeGoogleConfig;
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
 fields(value,['version','runtime','instanceId','principal','releaseSha','resourceRoot','workspaceCwd','stateDir','capabilityProfile','account','credentialPath','settingsPath','jobsRole','idleHours','transport','memory','google'],'Native configuration');
 if(value.version!==1||value.runtime!=='pi-durable') throw new Error('Unsupported native runtime or configuration version');
 if(value.jobsRole!=='disabled') throw new Error('Native test profiles require jobsRole disabled');
 const idleHours=value.idleHours??0;
 if(typeof idleHours!=='number'||!Number.isFinite(idleHours)||idleHours<0||idleHours>8760)throw new Error('Invalid idleHours');
 const principal=text(value.principal,'principal');
 if(!['isaac','emma','household','engineering'].includes(principal)) throw new Error('Invalid principal');
 const capabilityProfile=text(value.capabilityProfile,'capability profile');
 if(!['durable-foundation-test','durable-chat-memory-test','durable-tools-test','durable-read-integrations-test'].includes(capabilityProfile)) throw new Error('Unsupported native capability profile');
 const resourceRoot=await realpath(absolute(value.resourceRoot,'resourceRoot'));
 const workspaceCwd=await realpath(absolute(value.workspaceCwd,'workspaceCwd'));
 const stateDir=await realpath(absolute(value.stateDir,'stateDir'));
 if(contains(resourceRoot,stateDir)||contains(stateDir,resourceRoot)||contains(stateDir,workspaceCwd)||contains(workspaceCwd,stateDir)) throw new Error('Native state, release and workspace roots must not overlap');
 const stateStat=await lstat(stateDir);
 if(!stateStat.isDirectory() || (stateStat.mode&0o077)!==0 || (process.getuid && stateStat.uid!==process.getuid())) throw new Error('Native state directory must be private and owned by this runtime');
 let memory: NativeMemoryConfig | undefined;
 if (isNativeMemoryProfile(capabilityProfile)) {
  const selected = record(value.memory, 'memory');
  fields(selected, ['vaultRoot','gitAutocommit','legacySessionRoots','timeZone','recall','semantic','judgeKeyFile','embeddingKeyFile'], 'memory');
  if (principal === 'engineering') throw new Error('Chat-memory profile requires a memory principal');
  if (typeof selected.gitAutocommit !== 'boolean') throw new Error('Invalid memory gitAutocommit');
  if (selected.recall !== 'jev' && selected.recall !== 'off') throw new Error('Invalid memory recall flag');
  if (selected.semantic !== 'on' && selected.semantic !== 'off') throw new Error('Invalid memory semantic flag');
  if (!Array.isArray(selected.legacySessionRoots) || selected.legacySessionRoots.length > 64) throw new Error('Invalid legacy session roots');
  const legacySessionRoots = selected.legacySessionRoots.map(path => absolute(path, 'legacy session root'));
  if (new Set(legacySessionRoots).size !== legacySessionRoots.length) throw new Error('Duplicate legacy session root');
  const requestedVault = resolve(absolute(selected.vaultRoot, 'memory vault'));
  // Resolve existing ancestry and preserve the missing suffix for a new vault.
  let ancestor = requestedVault;
  let canonicalAncestor: string;
  for (;;) { try { canonicalAncestor = await realpath(ancestor); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; } }
  const vaultRoot = resolve(canonicalAncestor, relative(ancestor, requestedVault));
  if ([resourceRoot, workspaceCwd].some(root => contains(root, vaultRoot) || contains(vaultRoot, root))) throw new Error('Memory vault must be outside release and workspace');
  const timeZone = text(selected.timeZone, 'memory timeZone');
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new Error('Invalid memory timeZone'); }
  memory = { vaultRoot, gitAutocommit: selected.gitAutocommit, legacySessionRoots, timeZone, recall: selected.recall, semantic: selected.semantic,
   ...(selected.judgeKeyFile === undefined ? {} : { judgeKeyFile: absolute(selected.judgeKeyFile, 'judge key file') }),
   ...(selected.embeddingKeyFile === undefined ? {} : { embeddingKeyFile: absolute(selected.embeddingKeyFile, 'embedding key file') }) };
  if (memory.recall === 'jev' && !memory.judgeKeyFile) throw new Error('Enabled recall requires explicit provider authorization');
  if (memory.semantic === 'on' && !memory.embeddingKeyFile) throw new Error('Enabled semantic search requires explicit provider authorization');
 } else if (value.memory !== undefined) throw new Error('Foundation profile cannot select memory configuration');
 let google:NativeGoogleConfig|undefined;
 if(capabilityProfile==='durable-read-integrations-test'){
  const selected=record(value.google,'google');fields(selected,['account','gog','places','calendarTargets'],'google');google={};
  if(selected.account!==undefined)google.account=text(selected.account,'Google account');
  if(google.account&&(google.account.length>254||/[\0\r\n]/.test(google.account)))throw new Error('Invalid Google account');
  if(selected.gog!==undefined){
   const gog=record(selected.gog,'Google gog');fields(gog,['binary','passwordFile','home'],'Google gog');
   google.gog={binary:absolute(gog.binary,'Google binary'),passwordFile:absolute(gog.passwordFile,'Google password file'),home:absolute(gog.home,'Google home')};
  }
  if(selected.places!==undefined){
   const places=record(selected.places,'Google places');fields(places,['apiKeyFile','searchMonthlyLimit','detailsMonthlyLimit','candidatesMonthlyLimit'],'Google places');
   const limit=(key:string)=>{const result=places[key];if(typeof result!=='number'||!Number.isSafeInteger(result)||result<0||result>1_000_000)throw new Error('Invalid Places monthly limit');return result;};
   google.places={apiKeyFile:absolute(places.apiKeyFile,'Places API key file'),searchMonthlyLimit:limit('searchMonthlyLimit'),detailsMonthlyLimit:limit('detailsMonthlyLimit'),candidatesMonthlyLimit:limit('candidatesMonthlyLimit')};
  }
  if(selected.calendarTargets!==undefined){
   const targets=record(selected.calendarTargets,'Google calendar targets');fields(targets,['account','personal','thingsToDo'],'Google calendar targets');
   const account=text(targets.account,'Calendar account'),personal=text(targets.personal,'Personal calendar'),thingsToDo=text(targets.thingsToDo,'Things to Do calendar');
   if(!/^[^\s@]+@[^\s@]+$/.test(account)||account.length>254||personal===thingsToDo||[personal,thingsToDo].some(id=>id==='primary'||id.length>1024||/[\0\r\n]/.test(id)))throw new Error('Invalid Google calendar targets');
   google.calendarTargets={account,personal,thingsToDo};
  }
 }else if(value.google!==undefined)throw new Error('Google configuration requires the read-integrations profile');
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
 return {version:1,runtime:'pi-durable',instanceId:text(value.instanceId,'instanceId',/^[a-z0-9][a-z0-9-]{0,63}$/),principal:principal as NativeConfig['principal'],releaseSha:text(value.releaseSha,'releaseSha',/^[a-f0-9]{40}$/),resourceRoot,workspaceCwd,stateDir,capabilityProfile,account:text(value.account,'account',/^[a-zA-Z0-9._-]{1,128}$/),credentialPath:absolute(value.credentialPath,'credentialPath'),settingsPath:absolute(value.settingsPath,'settingsPath'),jobsRole:'disabled',idleHours,transport,...(memory ? { memory } : {}),...(google?{google}:{}),historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json')};
}
