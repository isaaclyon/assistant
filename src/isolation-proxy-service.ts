import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { assertAdministratorPath } from "./isolation-admin-path.js";
import { privateBrowserEndpoint } from "./private-browser-endpoint.js";
import { assertDemoPortUnused, isPrivateDemoProxy } from "./secure-input-demo-launch.js";

const [filename, kind] = process.argv.slice(2);
if (process.getuid?.() !== 0 || !filename || process.argv.length !== 4 || (kind !== "input" && kind !== "takeover")) {
  throw new Error("Private proxy requires administrator-owned endpoint configuration");
}
await assertAdministratorPath(filename);
const endpoint = privateBrowserEndpoint(kind, JSON.parse(await readFile(filename, "utf8")));
if (!endpoint) throw new Error("Private proxy endpoint is missing");
const exec = promisify(execFile);
const status = async (...args: string[]) => JSON.parse((await exec("/usr/bin/tailscale", args, { timeout: 5_000, maxBuffer: 1_000_000 })).stdout);
const dns = (await status("status", "--json")).Self?.DNSName;
if (dns !== `${new URL(endpoint.origin).hostname}.`) throw new Error("Private proxy host does not match Tailscale identity");
await assertDemoPortUnused(await status("serve", "status", "--json"), endpoint.listen.port);
const target = `http://${endpoint.listen.host}:${endpoint.listen.port}`;
const child = spawn("/usr/bin/tailscale", ["serve", "--yes", "--bg=false", `--https=${endpoint.listen.port}`, target], { stdio: "ignore" });
let stopping = false;
const stop = () => { stopping = true; child.kill("SIGTERM"); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
const exited = new Promise<void>(resolve => {
  child.once("exit", () => { if (!stopping) process.exitCode = 1; resolve(); });
  child.once("error", () => { process.exitCode = 1; resolve(); });
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 20 && !stopping && child.exitCode === null && child.signalCode === null; attempt++) {
    if (isPrivateDemoProxy(await status("serve", "status", "--json"), new URL(endpoint.origin).host, target)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Private proxy failed readiness");
  console.log("Private browser proxy ready.");
  await exited;
} finally {
  stop(); process.off("SIGTERM", stop); process.off("SIGINT", stop);
}
