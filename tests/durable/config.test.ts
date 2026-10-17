import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadNativeConfig } from '../../src/durable/config.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'native-config-')); dirs.push(root);
 const release = join(root,'release'), workspace = join(root,'workspace'), state = join(root,'state');
 await Promise.all([release,workspace,state].map(path=>mkdir(path,{mode:0o700})));
 const config = { version:1, runtime:'pi-durable', instanceId:'test', principal:'isaac', releaseSha:'a'.repeat(40), resourceRoot:release, workspaceCwd:workspace, stateDir:state, capabilityProfile:'durable-foundation-test', account:'test-account', credentialPath:join(root,'auth.json'), settingsPath:join(root,'settings.json'), jobsRole:'disabled', transport:{ mode:'broker', socketPath:join(root,'broker.sock'), botId:123, allowedUserId:42 } };
 const path=join(root,'instance.json');
 const save=async()=>writeFile(path,JSON.stringify(config),{mode:0o600}); await save();
 return {root,path,config,save};
}
test('requires explicit native generation and isolated canonical roots',async()=>{
 const f=await fixture(); const config=await loadNativeConfig(f.path);
 expect(config.runtime).toBe('pi-durable'); expect(config.workspaceCwd).toBe(await realpath(f.config.workspaceCwd));
 expect(config.historyDir).toBe(join(await realpath(f.config.stateDir),'durable'));
 expect(config.inboxPath).toBe(join(await realpath(f.config.stateDir),'inbox.db'));
 (f.config as any).runtime='legacy'; await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow(/runtime/);
});
test('rejects unknown fields, scheduling and accidental legacy resource profiles',async()=>{
 const f=await fixture(); (f.config as any).jobsRole='coordinator'; await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow(/jobsRole/);
 f.config.jobsRole='disabled'; f.config.capabilityProfile='personal-isaac'; await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow(/profile/);
 f.config.capabilityProfile='durable-foundation-test'; (f.config as any).token='secret'; await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow(/unknown field/);
});
test('rejects public configuration and state within the release',async()=>{
 const f=await fixture(); await chmod(f.path,0o644); await expect(loadNativeConfig(f.path)).rejects.toThrow(/private/);
 await chmod(f.path,0o600); f.config.stateDir=f.config.resourceRoot; await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow(/overlap/);
});
test('rejects symlinked configuration and broker options that allow direct fallback',async()=>{
 const f=await fixture(); const link=join(f.root,'link.json'); await symlink(f.path,link); await expect(loadNativeConfig(link)).rejects.toThrow(/regular/);
 (f.config.transport as any).tokenPath=join(f.root,'bot-token'); await f.save(); await expect(loadNativeConfig(f.path)).rejects.toThrow(/unknown field/);
});
