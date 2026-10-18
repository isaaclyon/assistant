import { lstat, readFile, realpath } from 'node:fs/promises';
import type { NativeCoordinatorConfig } from './coordinator.js';
import { SUPPORTED_NATIVE_CHECKER_IDS } from './schedules.js';
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
export const isNativeMemoryProfile=(profile:string)=>['durable-chat-memory-test','durable-tools-test','durable-read-integrations-test','durable-cli-integrations-test','durable-places-test','durable-mutations-test','durable-browser-test','durable-provider-test','durable-parity-test','durable-jobs-test','durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(profile);
export interface NativeGoogleConfig {
 account?:string;
 gog?:{binary:string;passwordFile:string;home:string};
 places?:{apiKeyFile:string;searchMonthlyLimit:number;detailsMonthlyLimit:number;candidatesMonthlyLimit:number};
 calendarTargets?:{account:string;personal:string;thingsToDo:string};
}
export interface NativeBrowserConfig {
 agentDir:string; telegramProfile:string; credentialScope:string; configRoot:string; runtimeDir:string; dataDir:string;
 endpoints?:{bindAddress:string;inputOrigin:string;takeoverOrigin:string};
}
export interface NativeConfig {
 version: 1; runtime: 'pi-durable'; instanceId: string; principal: 'isaac'|'emma'|'household'|'engineering';
 releaseSha: string; resourceRoot: string; workspaceCwd: string; stateDir: string;
 capabilityProfile: string; account: string; credentialPath: string; settingsPath: string; jobsRole: 'disabled'|'recipient'|'coordinator'; idleHours: number;
 transport: { mode:'ordinary'; profile:string; configPath:string; locksPath:string; botId:number; allowedUserId:number }
   | { mode:'broker'; socketPath:string; botId:number; allowedUserId:number };
 memory?: NativeMemoryConfig;
 google?: NativeGoogleConfig;
 cli?: { messagesBaseUrl?: string };
 browser?: NativeBrowserConfig;
 coordinator?: NativeCoordinatorConfig;
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
 fields(value,['version','runtime','instanceId','principal','releaseSha','resourceRoot','workspaceCwd','stateDir','capabilityProfile','account','credentialPath','settingsPath','jobsRole','idleHours','transport','memory','google','cli','browser','coordinator'],'Native configuration');
 if(value.version!==1||value.runtime!=='pi-durable') throw new Error('Unsupported native runtime or configuration version');
 const idleHours=value.idleHours??0;
 if(typeof idleHours!=='number'||!Number.isFinite(idleHours)||idleHours<0||idleHours>8760)throw new Error('Invalid idleHours');
 const principal=text(value.principal,'principal');
 if(!['isaac','emma','household','engineering'].includes(principal)) throw new Error('Invalid principal');
 const capabilityProfile=text(value.capabilityProfile,'capability profile');
 if(!['durable-foundation-test','durable-chat-memory-test','durable-tools-test','durable-read-integrations-test','durable-cli-integrations-test','durable-places-test','durable-mutations-test','durable-browser-test','durable-provider-test','durable-parity-test','durable-jobs-test','durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(capabilityProfile)) throw new Error('Unsupported native capability profile');
 if(value.jobsRole!==(['durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(capabilityProfile)?'coordinator':capabilityProfile==='durable-jobs-test'?'recipient':'disabled'))throw new Error('jobsRole must match the selected native profile');
 if(['durable-places-test','durable-mutations-test','durable-browser-test','durable-provider-test','durable-parity-test','durable-jobs-test','durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(capabilityProfile)&&principal!=='isaac')throw new Error('Places profile requires the Isaac principal');
 const resourceRoot=await realpath(absolute(value.resourceRoot,'resourceRoot'));
 const workspaceCwd=await realpath(absolute(value.workspaceCwd,'workspaceCwd'));
 const stateDir=await realpath(absolute(value.stateDir,'stateDir'));
 if(contains(resourceRoot,stateDir)||contains(stateDir,resourceRoot)||contains(stateDir,workspaceCwd)||contains(workspaceCwd,stateDir)) throw new Error('Native state, release and workspace roots must not overlap');
 const stateStat=await lstat(stateDir);
 if(!stateStat.isDirectory() || (stateStat.mode&0o077)!==0 || (process.getuid && stateStat.uid!==process.getuid())) throw new Error('Native state directory must be private and owned by this runtime');
 let coordinator:NativeCoordinatorConfig|undefined;
 if(['durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(capabilityProfile)){
  const selected=record(value.coordinator,'coordinator');fields(selected,['stateRoot','coordinatorStateDir','targets','scope',...(capabilityProfile==='durable-jobs-schedules-test'?['schedules']:[])],'coordinator');
  const requestedRoot=absolute(selected.stateRoot,'coordinator stateRoot'),requestedCoordinator=absolute(selected.coordinatorStateDir,'coordinator state directory');
  for(const directory of [requestedRoot,requestedCoordinator])if(!(await lstat(directory)).isDirectory())throw new Error('Coordinator paths must be real directories');
  const stateRoot=await realpath(requestedRoot),coordinatorStateDir=await realpath(requestedCoordinator);
  if(selected.scope!=='self'&&selected.scope!=='shared-owner')throw new Error('Invalid coordinator scope');
  if(!Array.isArray(selected.targets)||!selected.targets.length||selected.targets.length>64)throw new Error('Invalid coordinator targets');
  const targets=selected.targets.map(id=>text(id,'coordinator target',/^[a-z0-9][a-z0-9-]{0,63}$/));
  if(targets.includes('both-personal')||new Set(targets).size!==targets.length)throw new Error('Invalid coordinator targets');
  const instanceId=text(value.instanceId,'instanceId',/^[a-z0-9][a-z0-9-]{0,63}$/);
  if(selected.scope==='self'&&(targets.length!==1||targets[0]!==instanceId))throw new Error('Self coordinator requires its own target only');
  if(resolve(stateRoot,'instances',instanceId)!==stateDir)throw new Error('Coordinator recipient layout differs from native state directory');
  if(contains(coordinatorStateDir,join(stateRoot,'instances'))||contains(join(stateRoot,'instances'),coordinatorStateDir)||[resourceRoot,workspaceCwd].some(root=>contains(root,coordinatorStateDir)||contains(coordinatorStateDir,root)))throw new Error('Coordinator state overlaps another runtime root');
  for(const directory of [stateRoot,join(stateRoot,'instances'),coordinatorStateDir]){
   const meta=await lstat(directory);
   if(!meta.isDirectory()||(meta.mode&0o777)!==0o700||(process.getuid&&meta.uid!==process.getuid()))throw new Error('Coordinator directories must be private, owned real directories');
   if(await realpath(directory)!==resolve(directory))throw new Error('Coordinator directory ancestry must be canonical');
  }
  coordinator={stateRoot:resolve(stateRoot),coordinatorStateDir:resolve(coordinatorStateDir),targets,scope:selected.scope};
  if(capabilityProfile==='durable-jobs-schedules-test'){
   const schedules=record(selected.schedules,'coordinator schedules');fields(schedules,['checkerIds','judgeKeyFile','webhook'],'coordinator schedules');
   const supported:readonly string[]=SUPPORTED_NATIVE_CHECKER_IDS;
   if(!Array.isArray(schedules.checkerIds)||schedules.checkerIds.length>supported.length||schedules.checkerIds.some(id=>typeof id!=='string'||!supported.includes(id))||new Set(schedules.checkerIds).size!==schedules.checkerIds.length)throw new Error('Invalid native checker selection');
   const checkerIds=schedules.checkerIds as string[];
   let judgeKeyFile:string|undefined;
   if(schedules.judgeKeyFile!==undefined){
    judgeKeyFile=absolute(schedules.judgeKeyFile,'schedule judge key file');const meta=await lstat(judgeKeyFile);
    if(!meta.isFile()||meta.nlink!==1||(meta.mode&0o777)!==0o600||meta.size<1||meta.size>4096||(process.getuid&&meta.uid!==process.getuid()))throw new Error('Schedule judge key must be a private owned regular file');
   }
   let webhook:{port:number}|undefined;
   if(schedules.webhook!==undefined){const selectedWebhook=record(schedules.webhook,'schedule webhook');fields(selectedWebhook,['port'],'schedule webhook');const port=positive(selectedWebhook.port,'webhook port');if(port>65535)throw new Error('Invalid webhook port');webhook={port};}
   coordinator.schedules={checkerIds,...(judgeKeyFile?{judgeKeyFile}:{}),...(webhook?{webhook}:{})};
  }
 }else if(value.coordinator!==undefined)throw new Error('Coordinator configuration requires the coordinator profile');
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
 if(['durable-read-integrations-test','durable-cli-integrations-test','durable-places-test','durable-mutations-test','durable-browser-test','durable-provider-test','durable-parity-test','durable-jobs-test','durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(capabilityProfile)){
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
 let cli:NativeConfig['cli'];
 if(value.cli!==undefined){
  if(!['durable-cli-integrations-test','durable-places-test','durable-mutations-test','durable-browser-test','durable-provider-test','durable-parity-test','durable-jobs-test','durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(capabilityProfile))throw new Error('CLI configuration requires the CLI-integrations profile');
  const selected=record(value.cli,'cli');fields(selected,['messagesBaseUrl'],'cli');cli={};
  if(selected.messagesBaseUrl!==undefined){
   let url:URL;try{url=new URL(text(selected.messagesBaseUrl,'Messages base URL'));}catch{throw new Error('Invalid Messages base URL');}
   if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Messages base URL must be a credential-free HTTPS origin');
   cli.messagesBaseUrl=url.href;
  }
 }
 let browser:NativeBrowserConfig|undefined;
 if(['durable-browser-test','durable-provider-test','durable-parity-test','durable-jobs-test','durable-jobs-coordinator-test','durable-jobs-schedules-test'].includes(capabilityProfile)){
  const selected=record(value.browser,'browser');fields(selected,['agentDir','telegramProfile','credentialScope','configRoot','runtimeDir','dataDir','endpoints'],'browser');
  browser={agentDir:absolute(selected.agentDir,'browser agentDir'),telegramProfile:text(selected.telegramProfile,'browser Telegram profile',/^[a-z0-9-]+$/),credentialScope:text(selected.credentialScope,'credential scope',/^[a-z0-9][a-z0-9-]{0,63}$/),configRoot:absolute(selected.configRoot,'browser configRoot'),runtimeDir:absolute(selected.runtimeDir,'browser runtimeDir'),dataDir:absolute(selected.dataDir,'browser dataDir')};
  if(selected.endpoints!==undefined){
   const endpoints=record(selected.endpoints,'browser endpoints');fields(endpoints,['bindAddress','inputOrigin','takeoverOrigin'],'browser endpoints');
   browser.endpoints={bindAddress:text(endpoints.bindAddress,'browser bind address'),inputOrigin:text(endpoints.inputOrigin,'browser input origin'),takeoverOrigin:text(endpoints.takeoverOrigin,'browser takeover origin')};
   const {privateBrowserEndpoint}=await import('../private-browser-endpoint.js');
   privateBrowserEndpoint('input',{PI_PRIVATE_BROWSER_BIND_ADDRESS:browser.endpoints.bindAddress,PI_PRIVATE_INPUT_ORIGIN:browser.endpoints.inputOrigin,PI_PRIVATE_TAKEOVER_ORIGIN:browser.endpoints.takeoverOrigin});
  }
 }else if(value.browser!==undefined)throw new Error('Browser configuration requires the browser profile');
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
 if(browser){
  if(principal!=='isaac')throw new Error('Browser test profile requires the Isaac principal');
  if(transport.mode==='broker'&&!browser.endpoints)throw new Error('Broker browser requires provisioned private endpoints');
  if(transport.mode==='ordinary'&&(resolve(transport.configPath)!==resolve(browser.agentDir,'telegram.json')||transport.profile!==browser.telegramProfile))throw new Error('Browser and native Telegram profiles differ');
 }
 return {version:1,runtime:'pi-durable',instanceId:text(value.instanceId,'instanceId',/^[a-z0-9][a-z0-9-]{0,63}$/),principal:principal as NativeConfig['principal'],releaseSha:text(value.releaseSha,'releaseSha',/^[a-f0-9]{40}$/),resourceRoot,workspaceCwd,stateDir,capabilityProfile,account:text(value.account,'account',/^[a-zA-Z0-9._-]{1,128}$/),credentialPath:absolute(value.credentialPath,'credentialPath'),settingsPath:absolute(value.settingsPath,'settingsPath'),jobsRole:value.jobsRole as NativeConfig['jobsRole'],idleHours,transport,...(memory ? { memory } : {}),...(google?{google}:{}),...(cli?{cli}:{}),...(browser?{browser}:{}),...(coordinator?{coordinator}:{}),historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json')};
}
