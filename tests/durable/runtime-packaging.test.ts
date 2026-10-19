import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { parseBridgeInstanceManifest } from '../../src/instances.js';
import { resolveBridgeInstanceConfig } from '../../src/config.js';
import { renderInstanceServiceUnit, renderIsolatedInstanceServiceUnit } from '../../src/service-unit.js';
import { captureRecoverySnapshot, markRecoveryStarted, restoreRecoverySnapshot } from '../../src/recovery-snapshot.js';
import { releaseFromEntrypoint } from '../../src/runtime-entrypoint.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const sha='a'.repeat(40),release='/opt/bridge/releases/'+sha;
function config(){return resolveBridgeInstanceConfig(parseBridgeInstanceManifest(JSON.stringify({version:1,instances:[{id:'personal',displayName:'Fixture',principal:'isaac',telegramProfile:'personal',telegramSurface:{type:'private'},workspaceCwd:'/var/lib/pi-personal/workspace',capabilityProfile:'personal-isaac',credentialScope:'isaac-personal',memoryView:'owner-and-household',jobsRole:'coordinator'}]})),'personal',{PI_CODING_AGENT_DIR:'/var/lib/pi-personal/agent',PI_TELEGRAM_BRIDGE_STATE_ROOT:'/var/lib/pi-personal/state',PI_TELEGRAM_BRIDGE_CONFIG_ROOT:'/etc/pi-personal'},'/var/lib/pi-personal',release);}
it('renders a native executable and explicit config with the same maintenance hold and immutable release identity',()=>{
 const c=config(),shared={config:c,manifestPath:'/etc/pi-personal/instances.json',nodePath:'/opt/node/bin/node',projectDir:release,releaseSha:sha,runtime:{generation:'pi-durable' as const,configPath:'/etc/pi-personal/native.json'}};
 const native=renderInstanceServiceUnit(shared).contents;
 expect(native).toContain(`ExecStart="/opt/node/bin/node" "${release}/dist/src/durable/daemon.js"`);
 expect(native).toContain('Environment="PI_DURABLE_CONFIG=/etc/pi-personal/native.json"');
 expect(native).toContain('recovery-start-check.js');expect(native).toContain('PI_TELEGRAM_BRIDGE_STATE_ROOT=/var/lib/pi-personal/state');
 const {runtime:_,...legacyOptions}=shared;
 const legacy=renderInstanceServiceUnit(legacyOptions).contents;expect(legacy).toContain(`${release}/dist/src/daemon.js`);expect(legacy).not.toContain('PI_DURABLE_CONFIG');
 const digest='a'.repeat(64),pinned={...shared,runtime:{...shared.runtime,configSha256:digest}};
 expect(native).not.toContain('PI_DURABLE_CONFIG_SHA256');expect(renderInstanceServiceUnit(pinned).contents).toContain(`Environment="PI_DURABLE_CONFIG_SHA256=${digest}"`);
 const isolatedOptions={user:'pi_personal',group:'pi_personal',privateHome:'/var/lib/pi-personal',networkNamespace:'pi-personal',resolverPath:'/etc/pi-personal/resolv.conf',auditPolicyPath:'/etc/pi-personal/isolation-policy.json',trustedSocket:'/run/pi-broker-personal/telegram.sock',browserAddress:'10.203.0.2',privateInputOrigin:'https://fixture.tail.ts.net:8446',privateTakeoverOrigin:'https://fixture.tail.ts.net:8447'};
 expect(()=>renderIsolatedInstanceServiceUnit({...shared,...isolatedOptions})).toThrow(/pinned/);expect(()=>renderIsolatedInstanceServiceUnit({...pinned,runtime:{...pinned.runtime,configSha256:'xyz'},...isolatedOptions})).toThrow(/SHA-256/);
 const isolated=renderIsolatedInstanceServiceUnit({...pinned,...isolatedOptions}).contents;expect(isolated).toContain(`PI_DURABLE_CONFIG_SHA256=${digest}`);
 expect(isolated).toContain(`${release}/dist/src/durable/daemon.js`);expect(isolated).toContain('User=pi_personal');expect(isolated).toContain('NoNewPrivileges=yes');expect(isolated).toContain('NetworkNamespacePath=/run/netns/pi-personal');expect(isolated).toContain('pi-trusted-broker-personal.service');
 for(const configPath of ['/etc/../tmp/config','relative','/etc/%n','/etc/bad\nconfig'])expect(()=>renderInstanceServiceUnit({...shared,runtime:{generation:'pi-durable',configPath}})).toThrow();
});
it('resolves only exact legacy, native and broker entrypoints',()=>{
 expect(releaseFromEntrypoint(`${release}/dist/src/daemon.js`)).toEqual({release,runtime:'legacy'});
 expect(releaseFromEntrypoint(`${release}/dist/src/durable/daemon.js`)).toEqual({release,runtime:'pi-durable'});
 expect(releaseFromEntrypoint(`${release}/dist/src/trusted-broker-daemon.js`)).toEqual({release,runtime:'broker'});
 for(const value of [`${release}/other/daemon.js`,`${release}/dist/src/durable/../daemon.js`,'relative/dist/src/daemon.js'])expect(()=>releaseFromEntrypoint(value)).toThrow();
});
it('preserves a mixed native/legacy code-state checkpoint and forbids rewind after native candidate execution',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-package-')));roots.push(root);
 const stateRoot=join(root,'state'),unitDir=join(root,'units'),releaseRoot=join(root,'releases'),snapshotDir=join(root,'snapshot');
 await Promise.all([stateRoot,unitDir,releaseRoot].map(p=>mkdir(p,{mode:0o700})));
 await writeFile(join(stateRoot,'accepted-evidence'),'PRESERVE',{mode:0o600});
 for(const [name,id,suffix] of [['personal','a','durable/daemon.js'],['builder','b','daemon.js']]){
  const r=join(releaseRoot,id!.repeat(40)),exe=join(r,'dist/src',suffix!);await mkdir(join(exe,'..'),{recursive:true,mode:0o700});await writeFile(exe,`old ${name} binary`,{mode:0o600});
  await writeFile(join(unitDir,`pi-telegram-bridge-${name}.service`),`ExecStart="/usr/bin/node" "${exe}"\nEnvironment="PI_TELEGRAM_BRIDGE_STATE_ROOT=${stateRoot}"\n`,{mode:0o600});
 }
 await captureRecoverySnapshot({stateRoot,unitDir,releaseRoot,snapshotDir});
 await writeFile(join(stateRoot,'accepted-evidence'),'PRESTART-CHANGED',{mode:0o600});await restoreRecoverySnapshot(snapshotDir);expect(await readFile(join(stateRoot,'accepted-evidence'),'utf8')).toBe('PRESERVE');
 await markRecoveryStarted(snapshotDir);await writeFile(join(stateRoot,'accepted-evidence'),'NEW-ACCEPTED',{mode:0o600});
 await expect(restoreRecoverySnapshot(snapshotDir)).rejects.toThrow(/rewind is forbidden/i);expect(await readFile(join(stateRoot,'accepted-evidence'),'utf8')).toBe('NEW-ACCEPTED');
});
