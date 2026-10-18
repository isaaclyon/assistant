import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chown, cp, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";
import { loadCapabilityProfile } from "./capabilities.js";
import { resolveBridgeInstanceConfig, type BridgeInstanceConfig } from "./config.js";
import { validateCredentialEnvironmentFile } from "./credential-environment.js";
import { assertAdministratorPath } from "./isolation-admin-path.js";
import { evaluateIsolationIdentity, parseLinuxProcessStatus } from "./isolation-audit.js";
import { renderIsolationSupportUnits } from "./isolation-support-units.js";
import { activateIsolatedDeployment } from "./isolated-deployment.js";
import { applyIsolatedMigration, inventoryIsolatedMigration, type IsolatedMigrationPlan } from "./isolated-migration.js";
import { migrateTelegramOwnership, parsePrivateTelegramJson, splitTelegramOwnership } from "./isolated-telegram-migration.js";
import { loadIsolatedDeploymentConfig, type ManagedRuntime } from "./isolated-deployment-config.js";
import { captureIsolatedRecovery, markIsolatedRecoveryStarted, setTreeOwnership, writeDurableExclusive, type IsolatedRecoverySource } from "./isolated-recovery.js";
import { assertConfiguredBridgeUnits, assertServiceQuiescent, controlService, systemManager, type ManagedService } from "./isolated-service-control.js";
import { loadBridgeInstanceManifest } from "./instances.js";
import { loadValidatedJobs } from "./jobs-validation.js";
import { digestTree } from "./recovery-snapshot.js";
import { assertRuntimeReady, readRuntimeMetadata } from "./runtime-metadata.js";
import { renderInstanceServiceUnit, renderIsolatedInstanceServiceUnit, type RenderedInstanceServiceUnit } from "./service-unit.js";
import { parseTrustedBrokerConfig } from "./trusted-broker-config.js";
import { trustedTelegramFetch } from "./trusted-telegram-ipc.js";
import { activateRuntimeStage, assertCanaryObservation, assertCanaryEvidence, assertRuntimeAdvancement, inspectSelectedReleases, parseRuntimeActivation, runtimeActivationDigest, sameRuntimeMap, type RuntimeActivation, type CanaryObservation } from './durable/activation.js';
import { assertInstalledRuntimeSelection, assertNativeDeploymentBinding, readDeploymentTelegramIdentity } from './durable/deployment-config.js';
import { assertLegacyInboxDrained } from './durable/deployment-inbox.js';
import { releaseFromEntrypoint } from './runtime-entrypoint.js';
import { defaultReleaseEntrypoints, verifyRelease } from './durable/release-build.js';

const [sha, sourceRelease, action = "activate", configPath = "/etc/pi-telegram-bridge/isolated-deployment.json", migrationPath, activationPath, observationPath] = process.argv.slice(2);
if (process.getuid?.() !== 0 || process.platform !== "linux" || !sha || !/^[a-f0-9]{40}$/.test(sha) ||
    !sourceRelease || !["inventory", "preflight", "activate", "stage-preflight", "stage-activate", "stage-observe"].includes(action) || process.argv.length > 9) throw new Error("Isolated deployment requires root, full release SHA and a built release");
process.umask(0o077);
const policy = await loadIsolatedDeploymentConfig(configPath);
const staged = action.startsWith('stage-');
let activation:RuntimeActivation|undefined;
if(staged){
  if(!activationPath)throw new Error('Staged deployment requires an explicit administrator runtime map');
  await assertAdministratorPath(activationPath);
  activation=parseRuntimeActivation(JSON.parse(await readFile(activationPath,'utf8')),policy.runtimes.map(runtime=>runtime.instanceId));
  if(activation.releaseRoot!==policy.releaseRoot||activation.desired.find(runtime=>runtime.instanceId===activation!.selectedInstance)?.releaseSha!==sha)throw new Error('Staged release differs from the selected administrator mapping');
}else if(activationPath||observationPath)throw new Error('Runtime mapping arguments require a staged action');
const selectionFor=(instanceId:string)=>activation?.desired.find(runtime=>runtime.instanceId===instanceId);
const receiptRoot=join(policy.checkpointRoot,'runtime-activation');
const currentReceiptPath=join(receiptRoot,'current.json');
let previousStage:{plan:RuntimeActivation;observation?:CanaryObservation}|undefined;
let stageStartedAt=0;
const initialReady:Record<string,{at:number;pid:number}>={};
let releaseDigests:Record<string,string>={};
let previousReleaseDigests:Record<string,string>|undefined;
let migration: IsolatedMigrationPlan | undefined;
if (migrationPath && migrationPath !== '-') {
  await assertAdministratorPath(migrationPath);
  migration = JSON.parse(await readFile(migrationPath, "utf8"));
}
if(staged&&migration?.telegram)throw new Error('Staged runtime activation requires an already migrated Telegram identity');
await assertAdministratorPath(policy.nodePath);
const release = join(policy.releaseRoot, sha);
const personal = policy.runtimes.find(runtime => runtime.manager === "system")!;
const socketPath = `/run/pi-broker-${personal.instanceId}/telegram.sock`;
const existingTelegramIdentity=(runtime:ManagedRuntime,config:BridgeInstanceConfig)=>runtime===personal
 ?readDeploymentTelegramIdentity(policy.broker.configPath,policy.broker.uid)
 :readDeploymentTelegramIdentity(join(runtime.agentDir,'telegram.json'),runtime.uid,config.telegramProfile);
const support = renderIsolationSupportUnits({ instanceId: personal.instanceId, nodePath: policy.nodePath, releasePath: activation ? join(policy.releaseRoot,activation.brokerReleaseSha) : release,
  namespace: policy.network.namespace, networkConfigPath: policy.networkConfigPath, endpointConfigPath: policy.endpointConfigPath,
  brokerConfigPath: policy.broker.configPath, brokerHome: policy.broker.home, brokerUser: policy.broker.user, runtimeGroup: personal.user });
const services: ManagedService[] = [];
const candidates: Array<{ runtime: ManagedRuntime; config: BridgeInstanceConfig; unit: RenderedInstanceServiceUnit; service: ManagedService; nativeConfigDigest?:string }> = [];
const userManagers = policy.runtimes.filter(runtime => runtime.manager === "user");
const uniqueManagers = [systemManager, ...userManagers];
const holds = [...policy.runtimes.map(runtime => ({ path: join(runtime.stateRoot, ".recovery-maintenance"), uid: runtime.uid, gid: runtime.gid })),
  { path: join(policy.broker.home, ".recovery-maintenance"), uid: policy.broker.uid, gid: policy.broker.gid }];
const snapshot = join(policy.checkpointRoot, `checkpoint-${randomUUID()}`), authorization = randomUUID();
const exec = promisify(execFile);
const interrupted = new AbortController();
const interrupt = () => interrupted.abort();
process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function durableRemove(path: string): Promise<void> {
  await rm(path);
  const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function writeUnit(service: ManagedService, contents: string): Promise<void> {
  const temporary = `${service.path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
  if (service.manager.manager === "user") {
    const owner = userManagers.find(runtime => runtime.uid === service.manager.uid)!;
    await chown(temporary, owner.uid, owner.gid);
  }
  await rename(temporary, service.path);
  const directory = await open(dirname(service.path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function stopAll(): Promise<void> {
  let failed = false;
  for (const service of [...services].reverse()) {
    if (!await exists(service.path)) continue;
    try { await controlService(service.manager, "disable", "--now", service.name); } catch { failed = true; }
  }
  if (failed) throw new Error("Could not stop every managed writer");
}
async function quiescent(): Promise<void> {
  for (const service of services) if (await exists(service.path)) await assertServiceQuiescent(service);
}
async function assertFirstNativeInbox(runtime:ManagedRuntime,config:BridgeInstanceConfig):Promise<void> {
  if(selectionFor(runtime.instanceId)?.runtime==='pi-durable'&&activation?.previous.find(entry=>entry.instanceId===runtime.instanceId)?.runtime==='legacy') {
    await assertLegacyInboxDrained(join(config.stateDir,'inbox.db'),runtime.uid);
  }
}
let preflightComplete=false;
async function preflight(): Promise<void> {
  if(preflightComplete)return;
  if (migration) console.log(JSON.stringify({ migrationInventory: await inventoryIsolatedMigration(migration) }));
  if(activation){
    if(await exists(currentReceiptPath)){
      await assertAdministratorPath(currentReceiptPath);
      const receipt=JSON.parse(await readFile(currentReceiptPath,'utf8'));
      const plan=parseRuntimeActivation(receipt.plan,policy.runtimes.map(runtime=>runtime.instanceId));
      const observationFile=join(receiptRoot,plan.stageId,'observation.json');
      let observation:CanaryObservation|undefined;
      if(await exists(observationFile)){
        await assertAdministratorPath(observationFile);observation=JSON.parse(await readFile(observationFile,'utf8'));assertCanaryObservation(plan,observation);
        const evidenceFile=join(receiptRoot,plan.stageId,'evidence.json');await assertAdministratorPath(evidenceFile);
        const evidence=JSON.parse(await readFile(evidenceFile,'utf8'));
        assertCanaryEvidence(plan,observation!,evidence,receipt);
      }
      if(!receipt.releaseDigests||typeof receipt.releaseDigests!=='object'||Array.isArray(receipt.releaseDigests)||Object.values(receipt.releaseDigests).some(digest=>typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)))throw new Error('Retained release digest map is missing or invalid');
      previousReleaseDigests=receipt.releaseDigests;
      previousStage={plan,...(observation?{observation}:{})};
      if(!sameRuntimeMap(plan.desired,activation.previous))throw new Error('Previous runtime map differs from the retained active stage');
    }else if(activation.previous.some(entry=>entry.runtime==='pi-durable'))throw new Error('Previous native stage receipt is missing');
    assertRuntimeAdvancement(activation,previousStage);
    if(await exists(join(receiptRoot,activation.stageId)))throw new Error('Stage identity already exists; inspect the retained stage instead of replaying activation');
  }
  for (const marker of holds) if (await exists(marker.path)) throw new Error("Unresolved recovery hold blocks deployment");
  for (const runtime of [...policy.runtimes, policy.broker]) {
    const actual = (await exec("/usr/bin/id", [runtime.user], { timeout: 5_000 })).stdout;
    const uid = Number((await exec("/usr/bin/id", ["-u", runtime.user], { timeout: 5_000 })).stdout.trim());
    const gid = Number((await exec("/usr/bin/id", ["-g", runtime.user], { timeout: 5_000 })).stdout.trim());
    if (uid !== runtime.uid || gid !== runtime.gid || ((runtime === personal || runtime === policy.broker) && /\b(?:sudo|docker|lxd|adm|wheel)\b/.test(actual))) throw new Error("Service account identity is not isolated");
  }
  for (const path of [policy.releaseRoot, policy.checkpointRoot, personal.configRoot, policy.networkConfigPath, policy.endpointConfigPath, policy.resolverPath]) await assertAdministratorPath(path);
  if (JSON.stringify(JSON.parse(await readFile(policy.networkConfigPath, "utf8"))) !== JSON.stringify(policy.network)) throw new Error("Network configuration differs from deployment policy");
  const endpoint = JSON.parse(await readFile(policy.endpointConfigPath, "utf8"));
  if (endpoint.PI_PRIVATE_BROWSER_BIND_ADDRESS !== policy.network.runtimeAddress || endpoint.PI_PRIVATE_INPUT_ORIGIN !== policy.privateInputOrigin ||
      endpoint.PI_PRIVATE_TAKEOVER_ORIGIN !== policy.privateTakeoverOrigin) throw new Error("Private endpoint configuration differs from deployment policy");
  const broker = parseTrustedBrokerConfig(parsePrivateTelegramJson(await readFile(policy.broker.configPath, "utf8")));
  if (migration?.telegram) {
    const source = migration.telegram;
    const metadata = await lstat(source.sourcePath);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== source.sourceUid || (metadata.mode & 0o777) !== 0o600 ||
        await realpath(source.sourcePath) !== source.sourcePath) throw new Error("Unsafe selected Telegram migration source");
    splitTelegramOwnership(parsePrivateTelegramJson(await readFile(source.sourcePath, "utf8")), source.profile, broker);
  }
  if (broker.instance !== personal.instanceId || broker.socketPath !== socketPath || broker.databasePath !== join(policy.broker.stateDir, "telegram.db") ||
      broker.vault.home !== policy.broker.home) throw new Error("Broker configuration differs from deployment policy");
  await assertAdministratorPath(broker.vault.binary);
  for (const path of [policy.broker.configPath, broker.vault.tokenFile]) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== policy.broker.uid || (metadata.mode & 0o777) !== 0o600 || await realpath(path) !== path) throw new Error("Broker credentials have unsafe ownership");
  }
  // Source is produced by the already-authorized administrative deployer. Verify
  // a self-contained release before copying it into immutable root ownership.
  if (await realpath(sourceRelease!) !== sourceRelease) throw new Error("Noncanonical candidate release");
  const sourceUid = (await lstat(sourceRelease!)).uid;
  const sourceDigest = await digestTree(sourceRelease!, true, false, undefined, sourceUid);
  if(activation){
    await assertAdministratorPath(sourceRelease!);
    await assertAdministratorPath(dirname(sourceRelease!));
    await assertAdministratorPath(join(dirname(sourceRelease!),'.digests',`${sha}.json`));
    const built=await verifyRelease(dirname(sourceRelease!),sha!,[...defaultReleaseEntrypoints]);
    if(built.path!==sourceRelease||built.digest!==sourceDigest)throw new Error('Staged candidate differs from the exact immutable builder result');
  }
  if (!await exists(release)) {
    const staging = `${release}.staging-${randomUUID()}`;
    await cp(sourceRelease!, staging, { recursive: true, verbatimSymlinks: true });
    await setTreeOwnership(staging, 0, 0);
    if (await digestTree(staging, true, true) !== sourceDigest) throw new Error("Candidate release copy verification failed");
    await rename(staging, release);
    const directory=await open(policy.releaseRoot,'r');try{await directory.sync();}finally{await directory.close();}
  }
  await assertAdministratorPath(release);
  if (await digestTree(release, true) !== sourceDigest) throw new Error("Existing immutable release differs from candidate");
  if(activation){
    for(const selected of await inspectSelectedReleases(activation,{isolatedInstanceIds:[personal.instanceId]})){
      await assertAdministratorPath(selected.path);
      const retained=previousReleaseDigests?.[selected.releaseSha];
      if(previousReleaseDigests&&selected.releaseSha!==sha&&!retained)throw new Error('Previous release has no retained digest');
      if(retained&&retained!==selected.digest)throw new Error('Selected release differs from its retained digest');
      releaseDigests[selected.releaseSha]=selected.digest;
    }
  }
  for (const runtime of policy.runtimes) {
    const selected=selectionFor(runtime.instanceId);
    const runtimeRelease=selected?join(policy.releaseRoot,selected.releaseSha):release;
    const runtimeSha=selected?.releaseSha??sha!;
    const manifest = await loadBridgeInstanceManifest(runtime.manifestPath);
    if (runtime === personal && (manifest.instances.length !== 1 || manifest.instances[0]?.id !== runtime.instanceId)) throw new Error("Personal runtime must have a self-only manifest");
    const env = { PI_CODING_AGENT_DIR: runtime.agentDir, PI_TELEGRAM_BRIDGE_STATE_ROOT: runtime.stateRoot,
      PI_TELEGRAM_BRIDGE_CONFIG_ROOT: runtime.configRoot, PI_TELEGRAM_BRIDGE_RESOURCE_ROOT: runtimeRelease };
    const config = resolveBridgeInstanceConfig(manifest, runtime.instanceId, env, runtime.home, runtimeRelease);
    await validateCredentialEnvironmentFile(config.environmentFilePath, config.credentialScope, runtime.uid);
    const nativeBinding=selected?.runtime==='pi-durable'?await assertNativeDeploymentBinding(selected,runtime,config,policy.releaseRoot,runtime===personal?socketPath:undefined,await existingTelegramIdentity(runtime,config)):undefined;
    await loadCapabilityProfile(runtimeRelease,nativeBinding?.capabilityProfile??config.capabilityProfile);
    await assertFirstNativeInbox(runtime,config);
    if (runtime === personal) {
      if (migration?.telegram && migration.telegram.profile !== config.telegramProfile) throw new Error("Telegram migration profile does not match the selected personal runtime");
      if (config.telegramSurface.type !== "private" || config.jobsRole !== "coordinator") throw new Error("Isolated personal runtime must own its private jobs");
      if(selected?.runtime!=='pi-durable'){
        await loadValidatedJobs({ stateDir: config.stateDir, configuredInstanceIds: [runtime.instanceId] });
        if (!migration && !await exists(join(config.stateDir, "job-occurrences.db"))) throw new Error("Initialize legacy job recovery before isolation migration");
      }
    }
    const shared = { config, manifestPath: runtime.manifestPath, nodePath: policy.nodePath, projectDir: runtimeRelease, releaseSha: runtimeSha,
      ...(selected?.runtime==='pi-durable'?{runtime:{generation:'pi-durable' as const,configPath:selected.nativeConfigPath!,configSha256:nativeBinding!.digest}}:{}) };
    const unit = runtime === personal ? renderIsolatedInstanceServiceUnit({ ...shared, user: runtime.user, group: runtime.user, privateHome: runtime.home,
      networkNamespace: policy.network.namespace, resolverPath: policy.resolverPath, auditPolicyPath: join(runtime.configRoot, "isolation-policy.json"),
      trustedSocket: socketPath, browserAddress: policy.network.runtimeAddress, privateInputOrigin: policy.privateInputOrigin, privateTakeoverOrigin: policy.privateTakeoverOrigin }) : renderInstanceServiceUnit(shared);
    const service: ManagedService = { name: unit.unitName, manager: runtime, path: join(runtime.manager === "system" ? "/etc/systemd/system" : join(runtime.home, ".config/systemd/user"), unit.unitName) };
    if(activation){
      const previous=activation.previous.find(entry=>entry.instanceId===runtime.instanceId)!,installed=await readFile(service.path,'utf8');
      assertInstalledRuntimeSelection(installed,previous,policy.releaseRoot);
      if(sameRuntimeMap([previous],[selected!])&&installed!==unit.contents)throw new Error('Unchanged peer unit differs from the administrator rendering');
    }
    services.push(service); candidates.push({ runtime, config, unit, service,...(nativeBinding?{nativeConfigDigest:nativeBinding.digest}:{}) });
  }
  for (const unit of support) services.push({ name: unit.unitName, manager: systemManager, path: join("/etc/systemd/system", unit.unitName) });
  if(activation){
    const brokerUnit=support.find(unit=>unit.unitName===`pi-trusted-broker-${personal.instanceId}.service`)!;
    const installed=await readFile(join('/etc/systemd/system',brokerUnit.unitName),'utf8');
    const starts=[...installed.matchAll(/^ExecStart="[^"\r\n]+" "([^"\r\n]+)"(?: .*)?$/gm)];
    if(starts.length!==1||releaseFromEntrypoint(starts[0]![1]!).runtime!=='broker'||releaseFromEntrypoint(starts[0]![1]!).release!==join(policy.releaseRoot,activation.brokerReleaseSha))throw new Error('Staged activation cannot change the independent broker release');
  }
  // Keep the former user unit in the transition and permanently mask it. It may
  // never be recreated by the standard installer after a successful cutover.
  for (const manager of userManagers) {
    const name = `pi-telegram-bridge-${personal.instanceId}.service`;
    services.push({ name, manager, path: join(manager.home, ".config/systemd/user", name) });
  }
  await assertConfiguredBridgeUnits(services, uniqueManagers);
  preflightComplete=true;
  console.log("Isolated fleet preflight passed.");
}

await mkdir(policy.checkpointRoot, { recursive: true, mode: 0o700 });
await assertAdministratorPath(policy.checkpointRoot);
await withMutationLock(join(policy.checkpointRoot, "deployment-lock.sqlite"), async () => {
  if (action === "inventory") {
    if (!migration) throw new Error("Inventory requires a selected migration plan");
    console.log(JSON.stringify({ migrationInventory: await inventoryIsolatedMigration(migration) }));
    return;
  }
  if(action==='stage-observe'){
    if(!activation||!observationPath)throw new Error('Canary observation requires the exact stage and a private dispatch selection file');
    await assertAdministratorPath(currentReceiptPath);await assertAdministratorPath(observationPath);
    const current=JSON.parse(await readFile(currentReceiptPath,'utf8'));
    if(runtimeActivationDigest(parseRuntimeActivation(current.plan,policy.runtimes.map(runtime=>runtime.instanceId)))!==runtimeActivationDigest(activation))throw new Error('Only the retained active stage can be observed');
    const stageDirectory=join(receiptRoot,activation.stageId),selection=selectionFor(activation.selectedInstance)!;
    const runtime=policy.runtimes.find(entry=>entry.instanceId===activation!.selectedInstance)!;
    const unitName=`pi-telegram-bridge-${runtime.instanceId}.service`;
    const unitPath=join(runtime.manager==='system'?'/etc/systemd/system':join(runtime.home,'.config/systemd/user'),unitName);
    const service={name:unitName,path:unitPath,manager:runtime};
    assertInstalledRuntimeSelection(await readFile(unitPath,'utf8'),selection,policy.releaseRoot);
    const runtimeRelease=join(policy.releaseRoot,selection.releaseSha);
    await assertAdministratorPath(runtimeRelease);
    if(!current.releaseDigests?.[selection.releaseSha]||await digestTree(runtimeRelease,true)!==current.releaseDigests[selection.releaseSha])throw new Error('Canary release differs from the retained active digest');
    const manifest=await loadBridgeInstanceManifest(runtime.manifestPath);
    const config=resolveBridgeInstanceConfig(manifest,runtime.instanceId,{
      PI_CODING_AGENT_DIR:runtime.agentDir,PI_TELEGRAM_BRIDGE_STATE_ROOT:runtime.stateRoot,
      PI_TELEGRAM_BRIDGE_CONFIG_ROOT:runtime.configRoot,PI_TELEGRAM_BRIDGE_RESOURCE_ROOT:runtimeRelease,
    },runtime.home,runtimeRelease);
    await validateCredentialEnvironmentFile(config.environmentFilePath,config.credentialScope,runtime.uid);
    const observedBinding=await assertNativeDeploymentBinding(selection,runtime,config,policy.releaseRoot,runtime===personal?socketPath:undefined,await existingTelegramIdentity(runtime,config));
    assertInstalledRuntimeSelection(await readFile(unitPath,'utf8'),selection,policy.releaseRoot,observedBinding.digest);
    const initial=current.initialReady;
    if(!initial||!Number.isSafeInteger(initial.pid)||initial.pid<=0||!Number.isSafeInteger(initial.at)||!Number.isSafeInteger(current.startedAt)||initial.at<current.startedAt||Date.now()-initial.at<activation.observationMs)throw new Error('Canary observation interval or initial readiness is incomplete');
    const selectedDispatch=JSON.parse(await readFile(observationPath,'utf8'));
    if(!selectedDispatch||Object.keys(selectedDispatch).length!==1||typeof selectedDispatch.dispatchId!=='string'||!/^[a-z0-9-]{1,64}-[a-f0-9]{16}(?:[a-f0-9]{48})?$/.test(selectedDispatch.dispatchId))throw new Error('Canary dispatch selection must contain only an exact dispatchId');
    for(const retained of ['evidence.json','observation.json'])if(await exists(join(stageDirectory,retained)))throw new Error('Canary observation evidence already exists; inspect the retained result before another restart');
    const marker=join(runtime.stateRoot,'.recovery-maintenance'),token=randomUUID();
    if(await exists(marker))throw new Error('Unresolved hold blocks the canary restart');
    const metadataPath=join(runtime.stateRoot,'instances',runtime.instanceId,'runtime.json');
    const beforePid=Number(await controlService(runtime,'show',unitName,'--property=MainPID','--value'));
    assertRuntimeReady(await readRuntimeMetadata(metadataPath),{instanceId:runtime.instanceId,releaseSha:selection.releaseSha,pid:beforePid});
    let held=false;
    try{
      await writeDurableExclusive(marker,{version:1,authorization:token,snapshotDir:current.snapshotDir});held=true;await chown(marker,runtime.uid,runtime.gid);
      await controlService(runtime,'disable','--now',unitName);await assertServiceQuiescent(service);
      const inspected=await exec('/usr/sbin/runuser',['-u',runtime.user,'--','/usr/bin/env','-i',`HOME=${runtime.home}`,'PATH=/usr/bin:/bin',`PI_DURABLE_CONFIG=${selection.nativeConfigPath!}`,`PI_DURABLE_CONFIG_SHA256=${observedBinding.digest}`,policy.nodePath,join(policy.releaseRoot,selection.releaseSha,'dist/src/durable/inspect.js'),'--canary-dispatch',selectedDispatch.dispatchId],{timeout:30_000,maxBuffer:64_000});
      const proof=JSON.parse(inspected.stdout);
      if(proof.version!==1||proof.instanceId!==runtime.instanceId||proof.dispatchId!==selectedDispatch.dispatchId||proof.outcome!=='done'||typeof proof.submissionId!=='string'||!Number.isSafeInteger(proof.createdAt)||proof.createdAt<initial.at||!Number.isSafeInteger(proof.inspectedAt)||proof.inspectedAt<initial.at||proof.inspectedAt>Date.now())throw new Error('Selected dispatch lacks completed native work from this stage');
      await controlService(runtime,'set-environment',`PI_TELEGRAM_RECOVERY_AUTHORIZATION=${token}`);
      await controlService(runtime,'start',unitName);
      let restarted:{at:number;pid:number}|undefined;
      for(let attempt=0,stable=0,last=0;attempt<40;attempt++){
        try{
          const pid=Number(await controlService(runtime,'show',unitName,'--property=MainPID','--value'));
          assertRuntimeReady(await readRuntimeMetadata(metadataPath),{instanceId:runtime.instanceId,releaseSha:selection.releaseSha,pid});
          if(pid===initial.pid||pid===beforePid)throw new Error('Canary restart reused its prior process');
          if(runtime===personal&&evaluateIsolationIdentity(parseLinuxProcessStatus(await readFile(`/proc/${pid}/status`,'utf8')),{uid:runtime.uid,gid:runtime.gid}).length)throw new Error('Canary restart lost isolation');
          stable=pid===last?stable+1:1;last=pid;if(stable>=5){restarted={at:Date.now(),pid};break;}
        }catch{stable=0;last=0;}
        await pause(1000);
      }
      if(!restarted)throw new Error('Canary controlled restart did not become ready');
      const evidence={version:1,stageId:activation.stageId,proof,initialReady:initial,restartReady:restarted};
      const observation:CanaryObservation={version:1,stageId:activation.stageId,instanceId:runtime.instanceId,releaseSha:selection.releaseSha,startedAt:current.startedAt,initialReady:initial,restartReady:restarted,scheduledWork:{at:proof.inspectedAt,dispatchId:proof.dispatchId,submissionId:proof.submissionId,outcome:'done'},observedUntil:Date.now(),evidenceDigest:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
      assertCanaryObservation(activation,observation);
      await writeDurableExclusive(join(stageDirectory,'evidence.json'),evidence);
      await writeDurableExclusive(join(stageDirectory,'observation.json'),observation);
      await controlService(runtime,'unset-environment','PI_TELEGRAM_RECOVERY_AUTHORIZATION');
      await controlService(runtime,'enable',unitName);
      await durableRemove(marker);held=false;
      console.log('Canary completion, controlled restart and observation interval verified. Advancement remains an explicit staged invocation.');
    }catch(cause){
      if(held){await controlService(runtime,'unset-environment','PI_TELEGRAM_RECOVERY_AUTHORIZATION').catch(()=>{});await controlService(runtime,'disable','--now',unitName).catch(()=>{});await assertServiceQuiescent(service);}
      throw new Error('Canary observation failed; retain the hold and reconcile the selected runtime',{cause});
    }
    return;
  }
  if (action === "preflight" || action === 'stage-preflight') { await preflight(); return; }
  const operations = { preflight,
    hold: async () => {
      stageStartedAt=Date.now();
      if(activation){
        await mkdir(receiptRoot,{recursive:true,mode:0o700});await assertAdministratorPath(receiptRoot);
        const directory=join(receiptRoot,activation.stageId);await mkdir(directory,{mode:0o700});
        await writeDurableExclusive(join(directory,'stage.json'),{version:1,plan:activation,snapshotDir:snapshot,startedAt:stageStartedAt});
      }
      for (const marker of holds) {
        await writeDurableExclusive(marker.path, { version: 1, authorization, snapshotDir: snapshot });
        await chown(marker.path, marker.uid, marker.gid);
      }
    }, stopAll, assertQuiescent: quiescent,
    checkpoint: async () => {
      // Recheck before preservation. Cleanup verifies stopped writers
      // independently of pending legacy or newly accepted native rows.
      for (const candidate of candidates) await assertFirstNativeInbox(candidate.runtime,candidate.config);
      const sources: IsolatedRecoverySource[] = policy.runtimes.map(runtime => ({ role: `${runtime.instanceId}-state`, path: runtime.stateRoot, uid: runtime.uid, gid: runtime.gid, kind: "state" }));
      sources.push({ role: "broker-state", path: policy.broker.stateDir, uid: policy.broker.uid, gid: policy.broker.gid, kind: "state" });
      const priorReleases = new Set<string>();
      for (const [index, service] of services.entries()) {
        if (!await exists(service.path)) continue;
        const metadata = await lstat(service.path);
        if (metadata.isSymbolicLink() && await readlink(service.path) === "/dev/null") continue;
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64_000) throw new Error("Unsafe prior service unit");
        sources.push({ role: `unit-${index}`, path: service.path, uid: metadata.uid, gid: metadata.gid, kind: "unit" });
        const raw = await readFile(service.path, "utf8");
        for (const match of raw.matchAll(/^ExecStart="[^"]+" "([^"]+\/dist\/src\/(?:durable\/daemon|daemon|trusted-broker-daemon)\.js)"/gm)) {
          priorReleases.add(releaseFromEntrypoint(match[1]!).release);
        }
      }
      for (const [index, path] of [...priorReleases].entries()) {
        if (!/\/[a-f0-9]{40}$/.test(path)) throw new Error("Previous application is not an immutable release");
        const metadata = await lstat(path);
        sources.push({ role: `release-${index}`, path, uid: metadata.uid, gid: metadata.gid, kind: "release" });
      }
      const configSources = [configPath, personal.configRoot, policy.broker.configPath, policy.networkConfigPath, policy.endpointConfigPath, policy.resolverPath,
        ...candidates.flatMap(candidate => [candidate.runtime.manifestPath, candidate.config.environmentFilePath]),
        ...(activation?[activationPath!,...activation.desired.filter(entry=>entry.runtime==='pi-durable').map(entry=>entry.nativeConfigPath!),...(await exists(currentReceiptPath)?[receiptRoot]:[])]:[])];
      for (const [index, path] of configSources.entries()) {
        if (sources.some(source => path === source.path || path.startsWith(`${source.path}/`))) continue;
        const metadata = await lstat(path);
        sources.push({ role: `config-${index}`, path, uid: metadata.uid, gid: metadata.gid, kind: "config" });
      }
      await captureIsolatedRecovery(snapshot, sources);
      console.log("Paired runtime and broker checkpoint verified.");
    },
    migrate: async () => {
      if (!migration) return;
      await applyIsolatedMigration(migration, snapshot, quiescent);
      if (migration.telegram) await migrateTelegramOwnership({ ...migration.telegram,
        runtimePath: join(personal.agentDir, "telegram.json"), runtimeUid: personal.uid, runtimeGid: personal.gid,
        brokerPath: policy.broker.configPath, brokerUid: policy.broker.uid, brokerGid: policy.broker.gid,
      }, snapshot, quiescent);
      for (const candidate of candidates) if (candidate.runtime === personal) {
        await loadValidatedJobs({ stateDir: candidate.config.stateDir, configuredInstanceIds: [personal.instanceId] });
        if (!await exists(join(candidate.config.stateDir, "job-occurrences.db"))) throw new Error("Migrated job recovery ledger is missing");
      }
      console.log("Selected personal migration verified with all writers stopped.");
    },
    install: async () => {
      // Selected migration assets can introduce an inbox after the checkpoint.
      // Refuse legacy work before installing units or crossing the start barrier.
      for (const candidate of candidates) await assertFirstNativeInbox(candidate.runtime,candidate.config);
      for (const candidate of candidates){
        const selected=selectionFor(candidate.runtime.instanceId);
        if(selected?.runtime==='pi-durable'){
          const binding=await assertNativeDeploymentBinding(selected,candidate.runtime,candidate.config,policy.releaseRoot,candidate.runtime===personal?socketPath:undefined,await existingTelegramIdentity(candidate.runtime,candidate.config));
          if(binding.digest!==candidate.nativeConfigDigest)throw new Error('Native configuration changed after preflight');
          await loadCapabilityProfile(join(policy.releaseRoot,selected.releaseSha),binding.capabilityProfile);
        }
        await writeUnit(candidate.service, candidate.unit.contents);
      }
      for (const unit of support) await writeUnit(services.find(service => service.name === unit.unitName)!, unit.contents);
      for (const manager of userManagers) {
        const legacy = services.find(service => service.manager.uid === manager.uid && service.name === `pi-telegram-bridge-${personal.instanceId}.service`)!;
        if (await exists(legacy.path)) await rename(legacy.path, `${legacy.path}.retired-${randomUUID()}`);
        await symlink("/dev/null", legacy.path);
      }
      for (const manager of uniqueManagers) await controlService(manager, "daemon-reload");
    },
    markStarted: () => markIsolatedRecoveryStarted(snapshot),
    authorize: async () => { for (const manager of uniqueManagers) await controlService(manager, "set-environment", `PI_TELEGRAM_RECOVERY_AUTHORIZATION=${authorization}`); },
    start: async () => {
      for (const unit of support) await controlService(systemManager, "start", unit.unitName);
      let connected = false;
      const brokerDeadline = Date.now() + 25_000;
      while (Date.now() < brokerDeadline) {
        try {
          const response = await trustedTelegramFetch(socketPath)("https://api.telegram.org/bot0:runtime/getMe", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2_000) });
          if (response.ok) { connected = true; break; }
        } catch { /* bounded initialization wait */ }
        await pause(500);
      }
      if (!connected) throw new Error("Trusted broker did not become ready");
      for (const candidate of candidates) await controlService(candidate.runtime, "start", candidate.unit.unitName);
    },
    ready: async () => {
      for (const unit of support) {
        if (await controlService(systemManager, "show", unit.unitName, "--property=ActiveState", "--value") !== "active") throw new Error("Isolation support service is not active");
      }
      for (const candidate of candidates) {
        let stable = 0, lastPid = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            const pid = Number(await controlService(candidate.runtime, "show", candidate.unit.unitName, "--property=MainPID", "--value"));
            assertRuntimeReady(await readRuntimeMetadata(candidate.config.runtimeMetadataPath), { instanceId: candidate.runtime.instanceId, releaseSha: selectionFor(candidate.runtime.instanceId)?.releaseSha??sha!, pid });
            if (candidate.runtime === personal && evaluateIsolationIdentity(parseLinuxProcessStatus(await readFile(`/proc/${pid}/status`, "utf8")), { uid: personal.uid, gid: personal.gid }).length) throw new Error();
            stable = pid === lastPid ? stable + 1 : 1; lastPid = pid;
            if (stable >= 5) { initialReady[candidate.runtime.instanceId]={at:Date.now(),pid}; break; }
          } catch { stable = 0; lastPid = 0; }
          await pause(1000);
        }
        if (stable < 5) throw new Error("Candidate did not become stable and ready");
      }
      for (const unit of support) {
        if (await controlService(systemManager, "show", unit.unitName, "--property=ActiveState", "--value") !== "active") throw new Error("Isolation support service failed during readiness");
      }
    },
    revoke: async () => {
      const results = await Promise.allSettled(uniqueManagers.map(manager => controlService(manager, "unset-environment", "PI_TELEGRAM_RECOVERY_AUTHORIZATION")));
      if (results.some(result => result.status === "rejected")) throw new Error("Could not revoke every startup authorization");
    },
    enable: async () => {
      for (const candidate of candidates) await controlService(candidate.runtime, "enable", candidate.unit.unitName);
      for (const unit of support) await controlService(systemManager, "enable", unit.unitName);
    },
    complete: async () => {
      if(activation){
        const receipt={version:1,plan:activation,releaseDigests,snapshotDir:snapshot,startedAt:stageStartedAt,initialReady:initialReady[activation.selectedInstance]};
        await writeDurableExclusive(join(receiptRoot,activation.stageId,'ready.json'),receipt);
        const temporary=join(receiptRoot,`current-${randomUUID()}.json`);await writeDurableExclusive(temporary,receipt);await rename(temporary,currentReceiptPath);
        const directory=await open(receiptRoot,'r');try{await directory.sync();}finally{await directory.close();}
      }
      for (const marker of holds) await durableRemove(marker.path); console.log("Isolated fleet activation complete.");
    },
  };
  if(activation){await preflight();await activateRuntimeStage(activation,operations,previousStage,interrupted.signal);}
  else await activateIsolatedDeployment(operations, interrupted.signal);
}, { timeoutMs: 0 });
process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt);
