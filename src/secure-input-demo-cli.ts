import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadBridgeInstanceConfig } from "./config.js";
import { DEMO_DURATION_MS, startSecureInputDemo } from "./secure-input-demo.js";
import { assertDemoPortUnused, demoTelegramRequest, isPrivateDemoProxy, readDemoTelegramProfile } from "./secure-input-demo-launch.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tailscaleJson = async (...args: string[]) => JSON.parse((await exec("tailscale", args, { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 })).stdout);

async function main() {
  const [instanceId, rawPort = "8445", ...extra] = process.argv.slice(2);
  if (!instanceId || !/^\d{4,5}$/.test(rawPort) || extra.length) throw new Error("Usage: secure-input-demo-cli <instance-id> [https-port]");
  const port = Number(rawPort);
  const resourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const config = await loadBridgeInstanceConfig({ ...process.env, PI_TELEGRAM_BRIDGE_INSTANCE_ID: instanceId });
  if (config.telegramSurface.type !== "private") throw new Error("The demo supports private bot chats only");
  const profile = await readDemoTelegramProfile(config.agentDir, config.telegramProfile);
  const initial = await tailscaleJson("serve", "status", "--json");
  assertDemoPortUnused(initial, port);
  const dns: unknown = (await tailscaleJson("status", "--json")).Self?.DNSName;
  if (typeof dns !== "string" || !/^[a-z0-9.-]+\.ts\.net\.$/.test(dns)) throw new Error("Tailscale HTTPS hostname unavailable");
  const hostPort = `${dns.slice(0, -1)}:${port}`;
  const origin = `https://${hostPort}`;
  let proxy: ChildProcess | undefined;
  let messageId: number | undefined;
  let terminal = false;
  let notification: Promise<void> | undefined;
  let stop!: () => void;
  let stopRequested = false;
  const stopped = new Promise<void>((resolve) => { stop = () => { stopRequested = true; resolve(); }; });
  const signal = () => stop();
  const service = await startSecureInputDemo({ ...profile, origin, assetsDir: join(resourceRoot, "web/secure-input-demo"),
    onTerminal(status) {
      terminal = true;
      console.log(`Demo ${status}.`);
      if (messageId !== undefined) {
        notification = demoTelegramRequest(profile.botToken, "editMessageText", {
          chat_id: profile.userId, message_id: messageId,
          text: status === "completed" ? "✅ Private form demo completed. Telegram identity verified; sample submission accepted." : "Private form demo cancelled.",
          reply_markup: { inline_keyboard: [] },
        }).then(() => {}).catch(() => { console.error("Demo completion notice could not be delivered."); });
      }
    },
  });
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  const deadline = setTimeout(stop, DEMO_DURATION_MS);
  try {
    const target = `http://127.0.0.1:${service.port}`;
    // Foreground Serve disappears when this child exits; never change background mappings.
    proxy = spawn("sudo", ["-n", "tailscale", "serve", "--yes", "--bg=false", `--https=${port}`, target], { stdio: "ignore" });
    let proxyFailed = false;
    proxy.once("error", () => { proxyFailed = true; stop(); });
    proxy.once("exit", () => { proxyFailed = true; stop(); });
    let ready = false;
    for (let attempt = 0; attempt < 30 && !proxyFailed && !stopRequested; attempt++) {
      if (isPrivateDemoProxy(await tailscaleJson("serve", "status", "--json"), hostPort, target)) { ready = true; break; }
      await sleep(200);
    }
    if (!ready || proxyFailed || stopRequested) throw new Error("Private demo HTTPS proxy did not become ready");
    const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok || (await health.json() as { status?: string }).status !== "ok") throw new Error("Private demo HTTPS health check failed");
    if (stopRequested) return;
    messageId = await demoTelegramRequest(profile.botToken, "sendMessage", {
      chat_id: profile.userId,
      text: "Try the private form inside Telegram. Keep Tailscale connected and enter only the sample code 123456. This demo expires in 15 minutes.",
      reply_markup: { inline_keyboard: [[{ text: "Open test form", web_app: { url: `${origin}/#request=${service.requestId}` } }]] },
    });
    console.log(`Demo button delivered to the selected private bot chat. HTTPS ${origin}; expires in 15 minutes.`);
    await stopped;
    if (proxyFailed) throw new Error("Demo HTTPS proxy exited unexpectedly");
  } finally {
    clearTimeout(deadline);
    proxy?.kill("SIGTERM");
    await service.close();
    await notification;
    if (messageId !== undefined && !terminal) {
      await demoTelegramRequest(profile.botToken, "editMessageText", {
        chat_id: profile.userId, message_id: messageId,
        text: "Private form demo expired. Ask for a new test form.", reply_markup: { inline_keyboard: [] },
      }).catch(() => { console.error("Demo expiry notice could not be delivered."); });
    }
    // Verify foreground cleanup without disabling or overwriting another owner.
    let removed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await tailscaleJson("serve", "status", "--json");
      if (!isPrivateDemoProxy(status, hostPort, `http://127.0.0.1:${service.port}`)) { removed = true; break; }
      await sleep(100);
    }
    if (!removed) console.error("Demo proxy cleanup needs operator inspection; local server is closed.");
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
  }
}

main().catch(() => { console.error("Private form demo failed. Check instance configuration, the unused HTTPS port, and Tailscale permissions."); process.exitCode = 1; });
