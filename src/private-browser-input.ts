import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { agentSessionName, assertUnprotected, current, executable, paths, withSessionLock } from "../.pi/skills/agent-browser/scripts/stock-chrome.mjs";
import { assertDemoPortUnused, demoTelegramRequest, isPrivateDemoProxy, readDemoTelegramProfile } from "./secure-input-demo-launch.js";
import { protectBrowserPage, validateProtectedRequest, type ProtectedInputRequest } from "./protected-browser.js";
import { startPrivateInputServer, type PrivateInputStatus } from "./private-input-server.js";
import type { BridgeInstanceConfig } from "./config.js";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tailscale = async (...args: string[]) => JSON.parse((await exec("tailscale", args, { timeout: 5_000, maxBuffer: 2_000_000 })).stdout);

/** Active-turn operation: secrets cross only HTTP -> private CDP, never Pi. */
export async function runPrivateBrowserInput(options: {
  config: BridgeInstanceConfig; request: ProtectedInputRequest; chatId: number; threadId?: number;
  signal: AbortSignal; notifyWaiting(): void;
}): Promise<{ status: PrivateInputStatus | "unavailable" | "browser_blocked" }> {
  const { request, config } = options;
  validateProtectedRequest(request);
  if (config.telegramSurface.type !== "private" || config.instanceId !== process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID) return { status: "unavailable" };
  const profile = await readDemoTelegramProfile(config.agentDir, config.telegramProfile);
  if (profile.userId !== options.chatId) return { status: "unavailable" };
  const proxyRuntime = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-private-input-${process.getuid?.()}`);
  await mkdir(proxyRuntime, { recursive: true, mode: 0o700 });
  return withMutationLock(join(proxyRuntime, "proxy-lock.sqlite"), () => withSessionLock(request.session, async () => {
    await assertUnprotected(request.session);
    const location = paths(request.session);
    try { await access(join(location.runtimeDir, "handoff.json")); return { status: "unavailable" as const }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const browser = await current(request.session);
    if (!browser || options.signal.aborted) return { status: "unavailable" as const };
    let protectedPage: Awaited<ReturnType<typeof protectBrowserPage>> | undefined;
    let server: Awaited<ReturnType<typeof startPrivateInputServer>> | undefined;
    let proxy: ChildProcess | undefined;
    let messageId: number | undefined;
    let result: PrivateInputStatus | "unavailable" | "browser_blocked" = "unavailable";
    let closed = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      // Persist only the gate, never input. Crash recovery is deliberately stop-only.
      await writeFile(location.protectedPath, JSON.stringify({ version: 1, launchId: browser.launchId, requestId: randomUUID() }), { mode: 0o600, flag: "wx" });
      const binary = await executable("agent-browser", process.env.STOCK_BROWSER_AGENT_BROWSER);
      await exec(binary, ["--session", agentSessionName(request.session), "--cdp", String(browser.port), "close"], { timeout: 10_000, maxBuffer: 32_000 });
      protectedPage = await protectBrowserPage(browser.port, request);
      if (options.signal.aborted) controller.abort();
      if (controller.signal.aborted) throw new Error();
      // A single fixed private port serializes temporary input across instances.
      // Never replace another instance's endpoint or add public ingress.
      const port = 8446;
      assertDemoPortUnused(await tailscale("serve", "status", "--json"), port);
      const dns: unknown = (await tailscale("status", "--json")).Self?.DNSName;
      if (typeof dns !== "string" || !/^[a-z0-9.-]+\.ts\.net\.$/.test(dns)) throw new Error();
      const hostPort = `${dns.slice(0, -1)}:${port}`, origin = `https://${hostPort}`;
      server = await startPrivateInputServer({ ...profile, origin, request, signal: controller.signal,
        assetsDir: join(config.resourceRoot, "web/private-input"),
        submit: async (values) => {
          if (controller.signal.aborted || (await current(request.session))?.launchId !== browser.launchId) throw new Error();
          await protectedPage!.submit(values);
        },
      });
      const target = `http://127.0.0.1:${server.port}`;
      proxy = spawn("sudo", ["-n", "tailscale", "serve", "--yes", "--bg=false", `--https=${port}`, target], { stdio: "ignore" });
      proxy.once("error", abort); proxy.once("exit", abort);
      let ready = false;
      for (let attempt = 0; attempt < 30 && !controller.signal.aborted; attempt++) {
        if (isPrivateDemoProxy(await tailscale("serve", "status", "--json"), hostPort, target)) { ready = true; break; }
        await sleep(200);
      }
      if (!ready || controller.signal.aborted) throw new Error();
      const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (!health.ok) throw new Error();
      messageId = await demoTelegramRequest(profile.botToken, "sendMessage", {
        chat_id: profile.userId, ...(options.threadId ? { message_thread_id: options.threadId } : {}),
        text: `Enter sign-in details for ${new URL(request.pageUrl).origin}. The button fills and submits that website's form. Keep Tailscale connected. Expires in 10 minutes.`,
        reply_markup: { inline_keyboard: [[{ text: "Enter securely", web_app: { url: `${origin}/#request=${server.requestId}` } }]] },
      });
      options.notifyWaiting();
      result = await server.done;
    } catch { result = controller.signal.aborted ? "cancelled" : "unavailable"; }
    finally {
      controller.abort(); options.signal.removeEventListener("abort", abort);
      await server?.close();
      proxy?.kill("SIGTERM");
      try {
        await protectedPage?.close();
        closed = true;
      } catch { result = "browser_blocked"; }
      if (closed) await rm(location.protectedPath, { force: true });
      if (messageId !== undefined) {
        await demoTelegramRequest(profile.botToken, "editMessageText", {
          chat_id: profile.userId, message_id: messageId, reply_markup: { inline_keyboard: [] },
          text: result === "submitted" ? "Sign-in form submitted. The assistant will check the result." :
            result === "cancelled" ? "Private input cancelled." : result === "expired" ? "Private input expired." :
            "Private input ended. The assistant will explain the next step.",
        }).catch(() => {});
      }
    }
    return { status: result };
  }));
}
