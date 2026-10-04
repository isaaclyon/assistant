import { execFile } from "node:child_process";
import { join } from "node:path";
import type { BridgeInstanceConfig } from "./config.js";

/** Existing scoped/domain-checked provider, with stdout kept inside the host. */
export function privateLoginCredential(config: BridgeInstanceConfig, itemRef: string, url: string, signal: AbortSignal): Promise<{ username: string; password: string } | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  const env = Object.fromEntries(["HOME", "PATH", "LANG", "XDG_CONFIG_HOME", "PI_TELEGRAM_BRIDGE_CONFIG_ROOT", "ONEPASSWORD_CLI"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  return new Promise(resolve => {
    const child = execFile(process.execPath, [join(config.resourceRoot, ".pi/skills/agent-browser/scripts/onepassword-credentials.mjs")],
      { env: { ...env, PI_TELEGRAM_CREDENTIAL_SCOPE: config.credentialScope }, timeout: 20_000, maxBuffer: 16_000, signal }, (error, stdout) => {
        try {
          if (error || signal.aborted) { resolve(undefined); return; }
          const result = JSON.parse(stdout), value = result.credential;
          resolve(result.protocol === "agent-browser.plugin.v1" && result.success === true && value?.url === url &&
            [value.username, value.password].every(v => typeof v === "string" && v.length > 0 && v.length <= 1024) ? { username: value.username, password: value.password } : undefined);
        } catch { resolve(undefined); }
      });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ protocol: "agent-browser.plugin.v1", type: "credential.resolve", capability: "credential.read", request: { itemRef, url, originPolicy: "exact" } }));
  });
}
