import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { agentSessionName, assertUnprotected, current, executable, paths, withSessionLock } from "../.pi/skills/agent-browser/scripts/stock-chrome.mjs";
import { hasActiveHandoff, startPrivateHandoff, stopPrivateHandoff, resizePrivateHandoff } from "../.pi/skills/agent-browser/scripts/browser-handoff.mjs";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";
import { assertDemoPortUnused, demoTelegramRequest, isPrivateDemoProxy, readDemoTelegramProfile } from "./secure-input-demo-launch.js";
import { protectBrowserTakeover, validateTakeoverRequest, type TakeoverRequest } from "./browser-takeover-protection.js";
import { startTakeoverServer, type TakeoverResult } from "./browser-takeover-server.js";
import type { BridgeInstanceConfig } from "./config.js";
import { protectPrivateLogin, validatePrivateLoginRequest, type PrivateLoginRequest } from "./private-login.js";
import { privateLoginCredential } from "./private-login-credential.js";
import type { PrivateLoginOperations } from "./browser-takeover-server.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const serveStatus = async () => JSON.parse((await exec("tailscale", ["serve", "status", "--json"], { timeout: 5_000, maxBuffer: 2_000_000 })).stdout);
const httpsPort = 8447;
type Result = TakeoverResult | { status: "unavailable" | "browser_blocked" };

export async function runBrowserTakeover(options: {
  config: BridgeInstanceConfig; request: TakeoverRequest; chatId: number; threadId?: number;
  signal: AbortSignal; notifyWaiting(): void;
  login?: PrivateLoginRequest;
}): Promise<Result> {
  const { config, request } = options;
  validateTakeoverRequest(request);
  if (options.login) {
    validatePrivateLoginRequest(options.login);
    if (options.login.session !== request.session || options.login.resumeUrl !== request.resumeUrl) throw new Error("Invalid private sign-in request");
  }
  if (config.telegramSurface.type !== "private" || config.instanceId !== process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID || options.signal.aborted) return { status: "unavailable" };
  const profile = await readDemoTelegramProfile(config.agentDir, config.telegramProfile);
  if (options.chatId !== profile.userId) return { status: "unavailable" };
  const runtime = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-browser-takeover-${process.getuid?.()}`);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  return withMutationLock(join(runtime, "proxy-lock.sqlite"), () => withSessionLock(request.session, async () => {
    try { await assertUnprotected(request.session); } catch { return { status: "browser_blocked" as const }; }
    const location = paths(request.session);
    if (await hasActiveHandoff(request.session)) return { status: "unavailable" as const };
    const browser = await current(request.session);
    if (!browser || options.signal.aborted) return { status: "unavailable" as const };
    let protectedPage: Awaited<ReturnType<typeof protectBrowserTakeover>> | undefined;
    let login: PrivateLoginOperations | undefined;
    let server: Awaited<ReturnType<typeof startTakeoverServer>> | undefined;
    let proxy: ChildProcess | undefined, messageId: number | undefined;
    let handoffStarted = false, gateOwned = false, cleanupFailed = false;
    let result: Result = { status: "unavailable" };
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      assertDemoPortUnused(await serveStatus(), httpsPort);
      await writeFile(location.protectedPath, JSON.stringify({ version: 1, launchId: browser.launchId, requestId: randomUUID(), purpose: "takeover" }), { mode: 0o600, flag: "wx" });
      gateOwned = true;
      const binary = await executable("agent-browser", process.env.STOCK_BROWSER_AGENT_BROWSER);
      await exec(binary, ["--session", agentSessionName(request.session), "--cdp", String(browser.port), "close"], { timeout: 10_000, maxBuffer: 32_000 });
      protectedPage = await protectBrowserTakeover(browser.port, request);
      if (options.login) {
        const loginRequest = options.login, loginAbort = new AbortController();
        const loginSignal = AbortSignal.any([controller.signal, loginAbort.signal]);
        const page = await protectPrivateLogin(browser.port, loginRequest, loginSignal);
        login = { state: page.state, submit: page.submit, close: () => { loginAbort.abort(); page.close(); },
          ...(loginRequest.credentialItem ? { saved: async () => {
            const state = page.state();
            if (state.state !== "fields" || state.fields.includes("code")) return;
            const credential = await privateLoginCredential(config, loginRequest.credentialItem!, loginRequest.pageUrl, loginSignal);
            if (!credential) return;
            try { if (page.matchesUsername(credential.username)) return state.fields.map(kind => kind === "username" ? credential.username : credential.password); }
            finally { credential.username = ""; credential.password = ""; }
          } } : {}),
        };
      }
      if (options.signal.aborted) throw new Error();
      handoffStarted = true;
      const handoff = await startPrivateHandoff(request.session);
      if (handoff.passwordPath !== join(location.runtimeDir, "handoff-password")) throw new Error();
      const metadata = await lstat(handoff.passwordPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)) throw new Error();
      const password = (await readFile(handoff.passwordPath, "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{8}$/.test(password)) throw new Error();
      const dns = JSON.parse((await exec("tailscale", ["status", "--json"], { timeout: 5_000, maxBuffer: 2_000_000 })).stdout).Self?.DNSName;
      if (typeof dns !== "string" || !/^[a-z0-9.-]+\.ts\.net\.$/.test(dns)) throw new Error();
      const hostPort = `${dns.slice(0, -1)}:${httpsPort}`, origin = `https://${hostPort}`;
      if (controller.signal.aborted) throw new Error();
      server = await startTakeoverServer({ ...profile, origin, resourceRoot: config.resourceRoot, upstreamPort: handoff.webPort,
        password, resumeUrl: request.resumeUrl, signal: controller.signal,
        ...(login ? { login } : {}),
        resize: async viewport => {
          if (controller.signal.aborted) throw new Error();
          const size = await protectedPage!.resize(viewport);
          if (controller.signal.aborted) throw new Error();
          await resizePrivateHandoff(request.session, size.width, size.height);
        },
        durationMs: Math.max(1, Date.parse(handoff.expiresAt) - Date.now()) });
      const target = `http://127.0.0.1:${server.port}`;
      proxy = spawn("sudo", ["-n", "tailscale", "serve", "--yes", "--bg=false", `--https=${httpsPort}`, target], { stdio: "ignore" });
      proxy.once("error", abort); proxy.once("exit", abort);
      let ready = false;
      for (let i = 0; i < 30 && !controller.signal.aborted; i++) {
        if (isPrivateDemoProxy(await serveStatus(), hostPort, target)) { ready = true; break; }
        await sleep(200);
      }
      if (!ready || controller.signal.aborted || !(await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok) throw new Error();
      if (controller.signal.aborted) throw new Error();
      messageId = await demoTelegramRequest(profile.botToken, "sendMessage", {
        chat_id: profile.userId, ...(options.threadId ? { message_thread_id: options.threadId } : {}),
        text: login ? `Sign in privately to ${new URL(request.resumeUrl).origin}. The assistant stays paused across steps. Keep Tailscale connected; take over inside the form if needed. Expires in 10 minutes.` : "Take over the browser privately. The assistant is paused. Keep Tailscale connected, complete your step, then tap Hand back. Expires in 10 minutes.",
        reply_markup: { inline_keyboard: [[{ text: login ? "Sign in privately" : "Take over", web_app: { url: `${origin}/#request=${server.requestId}` } }]] },
      });
      options.notifyWaiting();
      result = await server.done;
    } catch { result = controller.signal.aborted ? { status: "cancelled", mode: "private" } : { status: "unavailable" }; }
    finally {
      options.signal.removeEventListener("abort", abort); controller.abort();
      login?.close();
      // Revoke all input and display access before touching the page or its gate.
      let proxyRemoved = true;
      if (proxy) {
        proxy.kill("SIGTERM");
        try {
          let removed = false;
          for (let i = 0; i < 15; i++) {
            try { assertDemoPortUnused(await serveStatus(), httpsPort); removed = true; break; } catch { await sleep(100); }
          }
          if (!removed) { cleanupFailed = true; proxyRemoved = false; }
        } catch { cleanupFailed = true; proxyRemoved = false; }
      }
      if (proxyRemoved) { try { await server?.close(); } catch { cleanupFailed = true; } }
      else if (server) {
        server.quarantine();
        // Exceptional cleanup only. Retire the refusal-only listener when the
        // mapping is removed; this timer cannot hold the host open on shutdown.
        const quarantined = server;
        let checking = false;
        const retry = setInterval(() => {
          if (checking) return; checking = true;
          void serveStatus().then(status => {
            assertDemoPortUnused(status, httpsPort); clearInterval(retry);
            return quarantined.close();
          }).catch(() => {}).finally(() => { checking = false; });
        }, 5_000);
        retry.unref();
      }
      if (handoffStarted) { try { await stopPrivateHandoff(request.session); } catch { cleanupFailed = true; } }
      if (protectedPage) {
        try {
          if ((await current(request.session))?.launchId !== browser.launchId) throw new Error();
          await protectedPage.finish(!cleanupFailed && result.status === "handed_back" ? result.mode : "private");
        } catch { cleanupFailed = true; }
        finally { protectedPage.close(); }
      }
      if (cleanupFailed) result = { status: "browser_blocked" };
      else if (gateOwned) await rm(location.protectedPath, { force: true });
      if (messageId !== undefined) await demoTelegramRequest(profile.botToken, "editMessageText", {
        chat_id: profile.userId, message_id: messageId, reply_markup: { inline_keyboard: [] },
        text: result.status === "submitted" ? "Sign-in details submitted. The assistant will check the result." : result.status === "handed_back" ? "Browser handed back. The assistant will continue." : result.status === "expired" ? "Browser takeover expired. The private view is closed." : "Browser takeover ended. The assistant will explain the next step.",
      }).catch(() => {});
    }
    return result;
  }));
}
