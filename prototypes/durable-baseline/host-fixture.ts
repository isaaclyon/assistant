import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startBridgeHost } from "../../src/host.js";
export async function prepareHost(root: string) {
 const agentDir = join(root, "agent"), stateDir = join(root, "state"), sessionDir = join(stateDir, "sessions");
 await mkdir(agentDir, {recursive:true});
 await mkdir(sessionDir, {recursive:true});
 await mkdir(join(root, ".pi/telegram"), {recursive:true});
 await writeFile(join(root, ".pi/telegram/AGENTS.md"), "SYNTHETIC_HOST_INSTRUCTIONS");
 await writeFile(join(root, ".pi/capabilities.json"), JSON.stringify({version:1, resources:{extensions:[],skills:[],instructions:[{id:"test",path:".pi/telegram/AGENTS.md",enabled:true}]},profiles:[{id:"test",extensions:[],skills:[],instructions:"test"}]}));
 await writeFile(join(agentDir,"auth.json"),JSON.stringify({"openai-codex":{type:"oauth",access:"synthetic-token",refresh:"synthetic-refresh",expires:Date.now()+3600000}}));
 await writeFile(join(agentDir,"settings.json"),JSON.stringify({defaultProvider:"openai-codex",defaultModel:"gpt-6-luna",retry:{enabled:false},compaction:{enabled:false}}));
 const logger = {info:()=>{},warn:()=>{},error:()=>{}};
 return async () => {
      const host = await startBridgeHost({ config: {
        instanceId: "compat", displayName: "Compatibility", principal: "isaac", telegramProfile: "compat",
        telegramSurface: { type: "private" }, resourceRoot: root, workspaceCwd: root, capabilityProfile: "test",
        credentialScope: "isaac-personal", memoryView: "owner-and-household", jobsRole: "disabled",
        configuredInstanceIds: ["compat"], agentDir, stateRoot: root, configRoot: root, stateDir, sessionDir,
        inboxPath: join(stateDir, "inbox.db"), codexConfigPath: join(stateDir, "codex.json"),
        restartMarkerPath: join(stateDir, "restart.json"), runtimeMetadataPath: join(stateDir, "runtime.json"),
        checkerStateDir: join(stateDir, "checkers"), environmentFilePath: join(root, "instance.env"),
        webhookHost: "127.0.0.1", webhookPort: 0,
      }, logger });
 return host;
 };
}
