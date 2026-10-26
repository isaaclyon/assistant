import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { NativeCoordinatorConfig } from './coordinator.js';
import { parseScheduleClient, readScheduleKey, type ScheduleClientConfig } from '../schedule-control-client.js';
import { parseScheduleControl } from '../schedule-control-server.js';
import { assertMediaOnlyUpgrade } from './media-upgrade.js';
import { assertScheduleOnlyUpgrade, parseScheduleUpgradeFrom, readSchedulePredecessor, type ScheduleUpgradeFrom } from './schedule-upgrade.js';
import { SUPPORTED_NATIVE_CHECKER_IDS } from './schedules.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isNativeMemoryProfile, requireProfilePolicy } from './profiles.js';
import type { GroupSurface } from './surface.js';
export { isNativeMemoryProfile };

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
export interface NativeRoutingConfig { mode: 'jev'; judgeKeyFile: string }
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
 /** Explicit v1 instruction-signature migration from a retained immutable sibling release. */
 instructionUpgradeFrom?: string;
 /** Explicit pinned predecessor; permits only scheduleClient/coordinator.control changes. */
 scheduleUpgradeFrom?: ScheduleUpgradeFrom;
 /** Explicit pinned predecessor; permits only the media-stack bundle and its configuration to arrive. */
 mediaUpgradeFrom?: ScheduleUpgradeFrom;
 releaseSha: string; resourceRoot: string; workspaceCwd: string; stateDir: string;
 capabilityProfile: string; account: string; credentialPath: string; settingsPath: string; jobsRole: 'disabled'|'recipient'|'coordinator'; idleHours: number;
 transport: { mode:'ordinary'; profile:string; configPath:string; locksPath:string; botId:number; allowedUserId:number }
   | { mode:'broker'; socketPath:string; botId:number; allowedUserId:number };
 memory?: NativeMemoryConfig;
 /** Explicit opt-in; independent of memory recall. Absent means routing off. */
 routing?: NativeRoutingConfig;
 google?: NativeGoogleConfig;
 cli?: { messagesBaseUrl?: string };
 /** Unix socket of the media-stack gateway. Absent means the media tools register nothing. */
 mediaStack?: { socketPath: string };
 browser?: NativeBrowserConfig;
 coordinator?: NativeCoordinatorConfig;
 /** Delegated definition management; confers no coordinator or recipient-file access. */
 scheduleClient?: ScheduleClientConfig;
 /** Exact household group surface; absent for private profiles. */
 group?: GroupSurface;
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
export async function loadNativeConfig(path:string,options:{expectedSha256?:string}={}):Promise<NativeConfig> {
 absolute(path,'configuration path');
 if(options.expectedSha256!==undefined&&!/^[a-f0-9]{64}$/.test(options.expectedSha256))throw new Error('Invalid pinned configuration digest');
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()) throw new Error('Configuration must be a regular file');
 // One descriptor supplies the identity, the digest and the parsed bytes.
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bytes:Buffer;
 try{
  const opened=await handle.stat();
  if(!opened.isFile()||opened.ino!==stat.ino||opened.dev!==stat.dev)throw new Error('Configuration must be a regular file');
  if((opened.mode&0o077)!==0 || (process.getuid && opened.uid!==process.getuid())) throw new Error('Configuration must be private and owned by this runtime');
  if(opened.size>128_000)throw new Error('Native configuration is too large');
  bytes=await handle.readFile();
 }finally{await handle.close();}
 // An administrator pin protects against rewrites by the runtime identity.
 if(options.expectedSha256!==undefined&&createHash('sha256').update(bytes).digest('hex')!==options.expectedSha256)throw new Error('Native configuration differs from its pinned administrator digest');
 let raw:unknown; try{raw=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Invalid native configuration JSON');}
 const value=record(raw,'Native configuration');
 fields(value,['version','runtime','instanceId','principal','releaseSha','resourceRoot','workspaceCwd','stateDir','capabilityProfile','account','credentialPath','settingsPath','jobsRole','idleHours','transport','memory','routing','google','cli','mediaStack','browser','coordinator','scheduleClient','group','instructionUpgradeFrom','scheduleUpgradeFrom','mediaUpgradeFrom'],'Native configuration');
 if(value.version!==1||value.runtime!=='pi-durable') throw new Error('Unsupported native runtime or configuration version');
 const idleHours=value.idleHours??0;
 if(typeof idleHours!=='number'||!Number.isFinite(idleHours)||idleHours<0||idleHours>8760)throw new Error('Invalid idleHours');
 const principal=text(value.principal,'principal');
 if(!['isaac','emma','household','engineering'].includes(principal)) throw new Error('Invalid principal');
 const capabilityProfile=text(value.capabilityProfile,'capability profile');
 const policy=requireProfilePolicy(capabilityProfile);
 if(!(policy.principals as readonly string[]).includes(principal))throw new Error('The selected native profile does not permit this principal');
 if(!(policy.jobsRoles as readonly string[]).includes(value.jobsRole as string))throw new Error('jobsRole must match the selected native profile');
 const resourceRoot=await realpath(absolute(value.resourceRoot,'resourceRoot'));
 let instructionUpgradeFrom:string|undefined;
 if(value.instructionUpgradeFrom!==undefined){
  instructionUpgradeFrom=text(value.instructionUpgradeFrom,'instructionUpgradeFrom',/^[a-f0-9]{40}$/);
  if(instructionUpgradeFrom===value.releaseSha||basename(resourceRoot)!==value.releaseSha)throw new Error('Instruction upgrade requires distinct SHA-named releases');
  const previous=join(dirname(resourceRoot),instructionUpgradeFrom);
  if(await realpath(previous)!==previous)throw new Error('Instruction predecessor must be canonical');
 }
 let scheduleUpgradeFrom:ScheduleUpgradeFrom|undefined;
 let mediaUpgradeFrom:ScheduleUpgradeFrom|undefined;
 if(value.mediaUpgradeFrom!==undefined){
  if(instructionUpgradeFrom||value.scheduleUpgradeFrom!==undefined)throw new Error('Select one native upgrade mode');
  mediaUpgradeFrom=parseScheduleUpgradeFrom(value.mediaUpgradeFrom);
  const prior=await readSchedulePredecessor(mediaUpgradeFrom,process.getuid!());
  assertMediaOnlyUpgrade(value,prior);
  if(await realpath(String(prior.resourceRoot))!==prior.resourceRoot)throw new Error('Media predecessor release must be canonical');
 }
 if(value.scheduleUpgradeFrom!==undefined){
  if(instructionUpgradeFrom)throw new Error('Select one native upgrade mode');
  scheduleUpgradeFrom=parseScheduleUpgradeFrom(value.scheduleUpgradeFrom);
  const prior=await readSchedulePredecessor(scheduleUpgradeFrom,process.getuid!());
  assertScheduleOnlyUpgrade(value,prior);
  if(await realpath(String(prior.resourceRoot))!==prior.resourceRoot)throw new Error('Schedule predecessor release must be canonical');
 }
 const workspaceCwd=await realpath(absolute(value.workspaceCwd,'workspaceCwd'));
 const stateDir=await realpath(absolute(value.stateDir,'stateDir'));
 if(contains(resourceRoot,stateDir)||contains(stateDir,resourceRoot)||contains(stateDir,workspaceCwd)||contains(workspaceCwd,stateDir)) throw new Error('Native state, release and workspace roots must not overlap');
 const stateStat=await lstat(stateDir);
 if(!stateStat.isDirectory() || (stateStat.mode&0o077)!==0 || (process.getuid && stateStat.uid!==process.getuid())) throw new Error('Native state directory must be private and owned by this runtime');
 let coordinator:NativeCoordinatorConfig|undefined;
 if(value.jobsRole==='coordinator'){
  const selected=record(value.coordinator,'coordinator');fields(selected,['stateRoot','coordinatorStateDir','targets','scope','control',...(policy.schedules!=='forbidden'?['schedules']:[])],'coordinator');
  if(policy.schedules==='required'&&selected.schedules===undefined)throw new Error('Coordinator schedules are required by the selected native profile');
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
  if(selected.control!==undefined)coordinator.control=parseScheduleControl(selected.control,targets);
  if(policy.schedules!=='forbidden'&&selected.schedules!==undefined){
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
 }else if(value.coordinator!==undefined)throw new Error('Coordinator configuration requires the coordinator role');
 let scheduleClient:ScheduleClientConfig|undefined;
 if(value.scheduleClient!==undefined){
  if(!policy.general||value.jobsRole==='coordinator')throw new Error('Delegated schedule client requires a non-coordinator general-tools profile');
  scheduleClient=parseScheduleClient(value.scheduleClient);
  await readScheduleKey(scheduleClient.keyFile);
 }
 let memory: NativeMemoryConfig | undefined;
 if (policy.memory!=='none') {
  const selected = record(value.memory, 'memory');
  fields(selected, ['vaultRoot','gitAutocommit','legacySessionRoots','timeZone','recall','semantic','judgeKeyFile','embeddingKeyFile'], 'memory');
  if ((principal === 'engineering') !== (policy.memory === 'history')) throw new Error('Chat-memory profile requires a memory principal');
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
  if (policy.memory === 'history' && (memory.recall !== 'off' || memory.semantic !== 'off')) throw new Error('History-only profile cannot enable recall or semantic memory');
 } else if (value.memory !== undefined) throw new Error('Foundation profile cannot select memory configuration');
 let routing:NativeRoutingConfig|undefined;
 if(value.routing!==undefined){
  const selected=record(value.routing,'routing');fields(selected,['mode','judgeKeyFile'],'routing');
  if(selected.mode!=='jev')throw new Error('Invalid routing mode');
  if(selected.judgeKeyFile===undefined)throw new Error('Enabled routing requires explicit provider authorization');
  const judgeKeyFile=absolute(selected.judgeKeyFile,'routing judge key file');
  const meta=await lstat(judgeKeyFile);
  if(!meta.isFile()||meta.nlink!==1||(meta.mode&0o777)!==0o600||meta.size<1||meta.size>4096||(process.getuid&&meta.uid!==process.getuid()))throw new Error('Routing judge key must be a private owned regular file');
  if(await realpath(judgeKeyFile)!==resolve(judgeKeyFile))throw new Error('Routing judge key path must be canonical');
  routing={mode:'jev',judgeKeyFile};
 }
 let google:NativeGoogleConfig|undefined;
 if(policy.google){
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
 let mediaStack:NativeConfig['mediaStack'];
 if(value.mediaStack!==undefined){
  if(!policy.mediaStack)throw new Error('Media stack configuration requires a profile that enables it');
  const selected=record(value.mediaStack,'mediaStack');fields(selected,['socketPath'],'mediaStack');
  mediaStack={socketPath:absolute(selected.socketPath,'Media stack socket path')};
 }
 let cli:NativeConfig['cli'];
 if(value.cli!==undefined){
  if(!policy.cli)throw new Error('CLI configuration requires the CLI-integrations profile');
  const selected=record(value.cli,'cli');fields(selected,['messagesBaseUrl'],'cli');cli={};
  if(selected.messagesBaseUrl!==undefined){
   let url:URL;try{url=new URL(text(selected.messagesBaseUrl,'Messages base URL'));}catch{throw new Error('Invalid Messages base URL');}
   if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Messages base URL must be a credential-free HTTPS origin');
   cli.messagesBaseUrl=url.href;
  }
 }
 let browser:NativeBrowserConfig|undefined;
 if(policy.browser){
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
 let group:GroupSurface|undefined;
 if(policy.surface==='group'){
  if(transport.mode==='broker')throw new Error('The trusted broker is private-only and cannot serve a household group');
  const selected=record(value.group,'group');fields(selected,['chatId','actors'],'group');
  const actors=record(selected.actors,'group actors');fields(actors,['isaac','emma'],'group actors');
  const chatId=selected.chatId;if(typeof chatId!=='number'||!Number.isSafeInteger(chatId)||chatId>=0)throw new Error('Group chatId must be a negative safe integer');
  const isaac=positive(actors.isaac,'group Isaac actor'),emma=positive(actors.emma,'group Emma actor');
  if(isaac===emma)throw new Error('Group actors must be distinct');
  if(![isaac,emma].includes(allowedUserId))throw new Error('Telegram pairing must be a group actor');
  group={chatId,actors:[{id:isaac,label:'Isaac'},{id:emma,label:'Emma'}]};
 }else if(value.group!==undefined)throw new Error('Group configuration requires a group profile');
 if(browser){
  const scope=policy.credentialScopes?.[principal as keyof typeof policy.credentialScopes];
  if(scope!==undefined&&browser.credentialScope!==scope)throw new Error('Browser credential scope does not match the selected profile principal');
  if(transport.mode==='broker'&&!browser.endpoints)throw new Error('Broker browser requires provisioned private endpoints');
  if(transport.mode==='ordinary'&&(resolve(transport.configPath)!==resolve(browser.agentDir,'telegram.json')||transport.profile!==browser.telegramProfile))throw new Error('Browser and native Telegram profiles differ');
 }
 return {...(instructionUpgradeFrom?{instructionUpgradeFrom}:{}),...(scheduleUpgradeFrom?{scheduleUpgradeFrom}:{}),...(mediaUpgradeFrom?{mediaUpgradeFrom}:{}),version:1,runtime:'pi-durable',instanceId:text(value.instanceId,'instanceId',/^[a-z0-9][a-z0-9-]{0,63}$/),principal:principal as NativeConfig['principal'],releaseSha:text(value.releaseSha,'releaseSha',/^[a-f0-9]{40}$/),resourceRoot,workspaceCwd,stateDir,capabilityProfile,account:text(value.account,'account',/^[a-zA-Z0-9._-]{1,128}$/),credentialPath:absolute(value.credentialPath,'credentialPath'),settingsPath:absolute(value.settingsPath,'settingsPath'),jobsRole:value.jobsRole as NativeConfig['jobsRole'],idleHours,transport,...(memory ? { memory } : {}),...(routing?{routing}:{}),...(google?{google}:{}),...(cli?{cli}:{}),...(mediaStack?{mediaStack}:{}),...(browser?{browser}:{}),...(coordinator?{coordinator}:{}),...(scheduleClient?{scheduleClient}:{}),...(group?{group}:{}),historyDir:join(stateDir,'durable'),inboxPath:join(stateDir,'inbox.db'),runtimeMetadataPath:join(stateDir,'runtime.json')};
}

/** Entrypoint loader. The unit's pinned digest is checked on every start. A
 * trusted-broker (isolated) configuration cannot run without that pin. */
export async function loadPinnedNativeConfig(path:string,environment:NodeJS.ProcessEnv=process.env):Promise<NativeConfig> {
 const pin=environment.PI_DURABLE_CONFIG_SHA256;
 if(pin!==undefined&&!/^[a-f0-9]{64}$/.test(pin))throw new Error('Invalid pinned configuration digest');
 const config=await loadNativeConfig(path,pin===undefined?{}:{expectedSha256:pin});
 if(config.transport.mode==='broker'&&pin===undefined)throw new Error('Isolated native configuration requires an administrator digest pin');
 return config;
}
