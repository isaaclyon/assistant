import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BridgeInstanceConfig } from '../config.js';
import type { ManagedRuntime } from '../isolated-deployment-config.js';
import { releaseFromEntrypoint } from '../runtime-entrypoint.js';
import type { RuntimeSelection } from './activation.js';
import { profilePolicy } from './profiles.js';
import { assertMediaOnlyUpgrade } from './media-upgrade.js';
import { assertScheduleOnlyUpgrade, parseScheduleUpgradeFrom, readSchedulePredecessor } from './schedule-upgrade.js';

/** Inspect configuration as data. Never import or execute candidate release code
 * before the paired checkpoint and irreversible startup barrier. Full native
 * schema/provider validation remains the runtime's own startup responsibility. */
export async function assertNativeDeploymentBinding(selection:RuntimeSelection,runtime:ManagedRuntime,config:BridgeInstanceConfig,releaseRoot:string,socketPath?:string,telegramIdentity?:{botId:number;allowedUserId:number},previous?:RuntimeSelection):Promise<{capabilityProfile:string;digest:string;scheduleControlDirectory?:string}> {
 if(selection.runtime!=='pi-durable'||!selection.nativeConfigPath)throw new Error('Native deployment selection is required');
 const expectedJobsRole=config.jobsRole==='target-only'?'recipient':config.jobsRole;
 const filename=selection.nativeConfigPath,meta=await lstat(filename);
 if(!meta.isFile()||meta.nlink!==1||meta.uid!==runtime.uid||(meta.mode&0o777)!==0o600||meta.size>128_000||await realpath(filename)!==filename)throw new Error('Native deployment configuration must be a private owned canonical file');
 const bytes=await readFile(filename);
 let value:Record<string,unknown>;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Invalid native deployment configuration');}
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.runtime!=='pi-durable'||value.instanceId!==runtime.instanceId||value.principal!==config.principal||value.releaseSha!==selection.releaseSha||value.resourceRoot!==join(releaseRoot,selection.releaseSha)||value.workspaceCwd!==config.workspaceCwd||value.stateDir!==config.stateDir||value.jobsRole!==expectedJobsRole)throw new Error('Native configuration differs from the administrator deployment binding');
 if(value.instructionUpgradeFrom!==undefined&&previous&&previous.releaseSha!==selection.releaseSha){
  if(previous.runtime!=='pi-durable'||!previous.nativeConfigPath||value.instructionUpgradeFrom!==previous.releaseSha)throw new Error('Instruction upgrade predecessor differs from the installed map');
  const info=await lstat(previous.nativeConfigPath);
  if(!info.isFile()||info.nlink!==1||info.uid!==runtime.uid||(info.mode&0o777)!==0o600||info.size>128_000||await realpath(previous.nativeConfigPath)!==previous.nativeConfigPath)throw new Error('Unsafe previous instruction configuration');
  const prior=JSON.parse(await readFile(previous.nativeConfigPath,'utf8'));
  const withoutRelease=(input:Record<string,unknown>)=>Object.fromEntries(Object.entries(input).filter(([key])=>!['releaseSha','resourceRoot','instructionUpgradeFrom'].includes(key)));
  if(!isDeepStrictEqual(withoutRelease(prior),withoutRelease(value)))throw new Error('Instruction upgrade cannot change runtime configuration');
 }
 if(value.scheduleUpgradeFrom!==undefined){
  if(value.instructionUpgradeFrom!==undefined||value.mediaUpgradeFrom!==undefined)throw new Error('Select one native upgrade mode');
  const ref=parseScheduleUpgradeFrom(value.scheduleUpgradeFrom);
  const prior=await readSchedulePredecessor(ref,runtime.uid);
  assertScheduleOnlyUpgrade(value,prior);
  if(previous&&previous.releaseSha!==selection.releaseSha&&
   (previous.runtime!=='pi-durable'||previous.nativeConfigPath!==ref.configPath||previous.releaseSha!==prior.releaseSha))throw new Error('Schedule upgrade predecessor differs from installed map');
 }
 if(value.mediaUpgradeFrom!==undefined){
  if(value.instructionUpgradeFrom!==undefined||value.scheduleUpgradeFrom!==undefined)throw new Error('Select one native upgrade mode');
  const ref=parseScheduleUpgradeFrom(value.mediaUpgradeFrom);
  const prior=await readSchedulePredecessor(ref,runtime.uid);
  assertMediaOnlyUpgrade(value,prior);
  if(previous&&previous.releaseSha!==selection.releaseSha&&
   (previous.runtime!=='pi-durable'||previous.nativeConfigPath!==ref.configPath||previous.releaseSha!==prior.releaseSha))throw new Error('Media upgrade predecessor differs from installed map');
 }
 const profile=value.capabilityProfile,policy=typeof profile==='string'?profilePolicy(profile):undefined;
 if(typeof profile!=='string'||!policy)throw new Error('Native capability profile is not explicit');
 // Production profiles map one to one from the legacy profile. Test profiles stay on their private surface.
 if(!profile.endsWith('-test')&&profile!==`durable-${config.capabilityProfile}`)throw new Error('Native capability profile differs from the legacy instance profile');
 if(!(policy.principals as readonly string[]).includes(config.principal)||!(policy.jobsRoles as readonly string[]).includes(value.jobsRole as string))throw new Error('Native capability profile does not permit the legacy principal or jobs role');
 const legacySurface=config.telegramSurface;
 if(policy.surface!==(legacySurface.type==='household-group'?'group':'private'))throw new Error('Native capability profile surface differs from the legacy Telegram surface');
 const credentialScope=policy.credentialScopes?.[config.principal];
 if(credentialScope!==undefined&&credentialScope!==config.credentialScope)throw new Error('Native capability profile credential scope differs from the legacy instance');
 const transport=value.transport as Record<string,unknown>|undefined;
 if(!transport||typeof transport!=='object'||Array.isArray(transport))throw new Error('Native deployment transport is missing');
 const id=(item:unknown)=>typeof item==='number'&&Number.isSafeInteger(item)&&item>0;
 if(!id(transport.botId)||!id(transport.allowedUserId))throw new Error('Native Telegram bot and user identities are required');
 if(telegramIdentity&&(transport.botId!==telegramIdentity.botId||transport.allowedUserId!==telegramIdentity.allowedUserId))throw new Error('Native Telegram identity differs from the selected existing transport');
 if(legacySurface.type==='household-group'){
  // The trusted broker accepts only the paired private chat, so it cannot carry a group surface.
  if(transport.mode==='broker')throw new Error('The trusted broker is private-only and cannot serve a household group');
  const group=value.group as Record<string,unknown>|undefined,actors=group?.actors as Record<string,unknown>|undefined;
  if(!group||typeof group!=='object'||Array.isArray(group)||!actors||typeof actors!=='object'||Array.isArray(actors)||Object.keys(group).sort().join()!=='actors,chatId'||Object.keys(actors).sort().join()!=='emma,isaac'||group.chatId!==legacySurface.chatId||actors.isaac!==legacySurface.actors.isaac||actors.emma!==legacySurface.actors.emma)throw new Error('Native group surface differs from the legacy household group');
  if(transport.allowedUserId!==legacySurface.actors.isaac&&transport.allowedUserId!==legacySurface.actors.emma)throw new Error('Native Telegram user is not a legacy group actor');
 }else if(value.group!==undefined)throw new Error('A private native profile cannot declare a group surface');
 let scheduleControlDirectory:string|undefined;
 if(runtime.manager==='system'){
  if(!socketPath||transport.mode!=='broker'||transport.socketPath!==socketPath)throw new Error('Isolated native runtime must use its selected trusted broker');
  if(config.jobsRole==='coordinator'){
   const coordinator=value.coordinator as Record<string,unknown>|undefined;
   if(!coordinator||coordinator.scope!=='self'||JSON.stringify(coordinator.targets)!==JSON.stringify([runtime.instanceId])||coordinator.stateRoot!==runtime.stateRoot||coordinator.coordinatorStateDir!==join(runtime.stateRoot,'coordinator'))throw new Error('Isolated native coordinator must select its own private state and target only');
   if(coordinator.control!==undefined){
    const control=coordinator.control as Record<string,unknown>;
    scheduleControlDirectory=`/run/pi-telegram-schedules/${runtime.instanceId}`;
    if(!control||typeof control!=='object'||Array.isArray(control)||control.socketPath!==`${scheduleControlDirectory}/control.sock`)throw new Error('Isolated schedule control requires its dedicated runtime socket directory');
   }
  }
 }else if(transport.mode!=='ordinary'||transport.configPath!==join(runtime.agentDir,'telegram.json')||transport.profile!==config.telegramProfile)throw new Error('Native ordinary transport differs from its selected legacy identity');
 return {capabilityProfile:value.capabilityProfile as string,digest:createHash('sha256').update(bytes).digest('hex'),...(scheduleControlDirectory?{scheduleControlDirectory}:{})};
}

/** Read only the selected transport identity. Never return or print its token. */
export async function readDeploymentTelegramIdentity(filename:string,uid:number,profile?:string):Promise<{botId:number;allowedUserId:number}>{
 const meta=await lstat(filename);
 if(!meta.isFile()||meta.nlink!==1||meta.uid!==uid||(meta.mode&0o777)!==0o600||meta.size>128_000||await realpath(filename)!==filename)throw new Error('Existing Telegram identity must be a private owned canonical file');
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 let value:unknown;try{value=JSON.parse(await readFile(filename,'utf8'));}catch{throw new Error('Existing Telegram identity is invalid');}
 let selected:unknown=value;
 if(profile!==undefined)selected=object(value)&&object(value.profiles)&&Object.hasOwn(value.profiles,profile)?value.profiles[profile]:undefined;
 if(!object(selected)||typeof selected.botToken!=='string'||!/^\d+:[A-Za-z0-9_-]+$/.test(selected.botToken))throw new Error('Existing Telegram identity is incomplete');
 const botId=Number(selected.botToken.split(':',1)[0]),allowedUserId=profile===undefined?selected.userId:selected.allowedUserId;
 if(!Number.isSafeInteger(botId)||botId<=0||typeof allowedUserId!=='number'||!Number.isSafeInteger(allowedUserId)||allowedUserId<=0||(selected.botId!==undefined&&selected.botId!==botId))throw new Error('Existing Telegram identity is inconsistent');
 return {botId,allowedUserId};
}

/** The prior map is a claim until checked against every installed executable.
 * A missing or ambiguous unit cannot establish an old runtime identity. */
export function assertInstalledRuntimeSelection(contents:string,selection:RuntimeSelection,releaseRoot:string,expectedConfigDigest?:string):void {
 const starts=[...contents.matchAll(/^ExecStart="[^"\r\n]+" "([^"\r\n]+)"\s*$/gm)];
 if(starts.length!==1)throw new Error('Installed runtime has no unique exact executable');
 const selected=releaseFromEntrypoint(starts[0]![1]!);
 if(selected.runtime!==selection.runtime||selected.release!==join(releaseRoot,selection.releaseSha))throw new Error('Installed executable differs from the previous runtime map');
 const sha=[...contents.matchAll(/^Environment="PI_TELEGRAM_BRIDGE_RELEASE_SHA=([^"\r\n]+)"\s*$/gm)];
 if(sha.length!==1||sha[0]![1]!==selection.releaseSha)throw new Error('Installed runtime release environment differs from its executable');
 if(selection.runtime==='pi-durable'&&expectedConfigDigest!==undefined){
  const pins=[...contents.matchAll(/^Environment="PI_DURABLE_CONFIG_SHA256=([^"\r\n]+)"\s*$/gm)];
  if(!/^[a-f0-9]{64}$/.test(expectedConfigDigest)||pins.length!==1||pins[0]![1]!==expectedConfigDigest)throw new Error('Installed native configuration digest differs from the administrator binding');
 }
 const native=[...contents.matchAll(/^Environment="PI_DURABLE_CONFIG=([^"\r\n]+)"\s*$/gm)];
 if(selection.runtime==='pi-durable'?(native.length!==1||resolve(native[0]![1]!)!==selection.nativeConfigPath):native.length!==0)throw new Error('Installed native configuration differs from the previous runtime map');
}
