import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BridgeInstanceConfig } from "./config.js";

/** Existing scoped/domain-checked provider, with stdout kept inside the host. */
export function privateLoginCredential(config: BridgeInstanceConfig, itemRef: string, url: string, signal: AbortSignal): Promise<{ username: string; password: string } | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  const env = Object.fromEntries(["HOME", "PATH", "LANG", "XDG_CONFIG_HOME", "PI_TELEGRAM_BRIDGE_CONFIG_ROOT", "ONEPASSWORD_CLI"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  return new Promise(resolve => {
    let interrupted = false, settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    const child = spawn(process.execPath, [join(config.resourceRoot, ".pi/skills/agent-browser/scripts/onepassword-credentials.mjs")],
      { env: { ...env, PI_TELEGRAM_CREDENTIAL_SCOPE: config.credentialScope }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"] });
    const killGroup = () => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* direct-child fallback */ }
      }
      child.kill("SIGKILL");
    };
    const stop = () => { if (!settled) { interrupted = true; killGroup(); } };
    const timer = setTimeout(stop, 20_000); timer.unref();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", stop); killGroup();
      const raw = Buffer.concat(chunks);
      try {
        if (code !== 0 || interrupted || signal.aborted) { resolve(undefined); return; }
        const result = JSON.parse(raw.toString("utf8")), value = result.credential;
        resolve(result.protocol === "agent-browser.plugin.v1" && result.success === true && value?.url === url &&
          [value.username, value.password].every(v => typeof v === "string" && v.length > 0 && v.length <= 1024) ? { username: value.username, password: value.password } : undefined);
      } catch { resolve(undefined); }
      finally { raw.fill(0); for (const chunk of chunks) chunk.fill(0); chunks.length = 0; }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (interrupted || settled || bytes > 16_000) { chunk.fill(0); stop(); return; }
      chunks.push(chunk);
    });
    child.once("error", () => finish(null)); child.once("close", finish);
    signal.addEventListener("abort", stop, { once: true });
    child.stdin?.on("error", () => {});
    if (signal.aborted) { stop(); return; }
    child.stdin?.end(JSON.stringify({ protocol: "agent-browser.plugin.v1", type: "credential.resolve", capability: "credential.read", request: { itemRef, url, originPolicy: "exact" } }));
  });
}
