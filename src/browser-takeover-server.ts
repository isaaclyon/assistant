import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { validateMiniAppIdentity } from "./secure-input-demo.js";
import { validTakeoverViewport, type TakeoverViewport } from "./browser-takeover-viewport.js";

export type TakeoverResult = { status: "handed_back" | "cancelled" | "expired" | "failed"; mode: "private" | "share" };

/** Authenticated display transport. No frames, input, or exceptions enter Pi. */
export async function startTakeoverServer(options: {
  origin: string; botToken: string; userId: number; resourceRoot: string;
  upstreamPort: number; password: string; resumeUrl: string; signal: AbortSignal; durationMs?: number;
  resize?(viewport: TakeoverViewport): Promise<void>;
}) {
  const origin = new URL(options.origin), duration = options.durationMs ?? 600_000;
  if (origin.protocol !== "https:" || origin.origin !== options.origin || origin.username || origin.password ||
      !Number.isInteger(options.upstreamPort) || options.upstreamPort < 1 || options.upstreamPort > 65535 ||
      !Number.isInteger(duration) || duration < 1 || duration > 600_000) throw new Error("Invalid takeover configuration");
  const expiresAt = Date.now() + duration;
  const requestId = randomBytes(24).toString("base64url");
  let ticket: string | undefined, ticketExpires = 0, consumed = false;
  let viewer: WebSocket | undefined, terminal: TakeoverResult | undefined, quarantined = false;
  let resizing = false, resizeWork = Promise.resolve();
  let settle!: (result: TakeoverResult) => void;
  const done = new Promise<TakeoverResult>(resolve => { settle = resolve; });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64_000, perMessageDeflate: false });
  const finish = (result: TakeoverResult) => {
    if (terminal) return;
    terminal = result; ticket = undefined;
    for (const ws of sockets.clients) ws.terminate();
    void resizeWork.catch(() => {}).then(() => settle(result));
  };
  const abort = () => finish({ status: "cancelled", mode: "private" });
  const ended = () => {
    if (options.signal.aborted) abort();
    if (Date.now() >= expiresAt) finish({ status: "expired", mode: "private" });
    return !!terminal;
  };
  const assets = new Map(await Promise.all([
    ["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/style.css", "style.css", "text/css"],
  ].map(async ([url, file, type]) => [url!, { type: type!, body: await readFile(join(options.resourceRoot, "web/browser-takeover", file!)) }] as const)));
  const novncRoot = await realpath(join(options.resourceRoot, "node_modules/@novnc/novnc"));
  const headers = {
    "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
  };
  const reply = (res: ServerResponse, code: number, body: object) => { res.writeHead(code, { ...headers, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let count = 0, windowStart = Date.now();
  const permit = () => { if (Date.now() - windowStart > 60_000) { count = 0; windowStart = Date.now(); } return ++count <= 240; };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (quarantined) { reply(res, 410, { error: "ended" }); return; }
    // A flood of public asset/health requests must not consume the paired user's
    // handback budget. Finish still requires bounded input, identity and ticket.
    if (!(req.method === "POST" && req.url === "/api/finish") && !permit()) { reply(res, 429, { error: "try_later" }); return; }
    if (req.method === "GET") {
      if (req.url === "/healthz") { reply(res, 200, { status: "ok" }); return; }
      let asset = assets.get(req.url ?? "");
      // Serve only the pinned noVNC browser modules, with canonical containment.
      if (!asset && /^\/novnc\/(?:core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(req.url ?? "") && !req.url!.includes("..")) {
        const path = await realpath(join(novncRoot, req.url!.slice(7))).catch(() => "");
        if (path.startsWith(novncRoot + sep)) asset = { type: "text/javascript", body: await readFile(path) };
      }
      if (asset) { res.writeHead(200, { ...headers, "content-type": `${asset.type}; charset=utf-8` }); res.end(asset.body); return; }
    }
    if (req.method !== "POST" || !["/api/auth", "/api/finish", "/api/viewport"].includes(req.url ?? "")) { reply(res, 404, { error: "not_found" }); return; }
    if (req.headers.origin !== options.origin || req.headers["content-type"] !== "application/json") { reply(res, 403, { error: "unauthorized" }); return; }
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 24_000) { reply(res, 413, { error: "too_large" }); return; } chunks.push(chunk as Buffer); }
      const raw = Buffer.concat(chunks); let input;
      try { input = JSON.parse(raw.toString("utf8")); } finally { raw.fill(0); }
      const keys = req.url === "/api/auth" ? ["requestId", "initData", "viewport"] : req.url === "/api/viewport" ? ["requestId", "initData", "ticket", "viewport"] : ["requestId", "initData", "ticket", "mode"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) { reply(res, 400, { error: "invalid_request" }); return; }
      if (input.requestId !== requestId || typeof input.initData !== "string" || !validateMiniAppIdentity(input.initData, options.botToken, options.userId, Date.now())) { reply(res, 403, { error: "unauthorized" }); return; }
      if (ended()) { reply(res, 410, { error: "ended" }); return; }
      const resize = async () => {
        resizing = true;
        resizeWork = Promise.resolve().then(() => options.resize?.(input.viewport));
        try { await resizeWork; } finally { resizing = false; }
      };
      if ((input.viewport !== undefined || req.url === "/api/viewport") && !validTakeoverViewport(input.viewport)) { reply(res, 400, { error: "invalid_viewport" }); return; }
      if (req.url === "/api/auth") {
        if (resizing || viewer || (ticket && !consumed && ticketExpires > Date.now())) { reply(res, 409, { error: "already_open" }); return; }
        if (input.viewport) {
          try { await resize(); }
          catch { finish({ status: "failed", mode: "private" }); reply(res, 503, { error: "unavailable" }); return; }
        }
        if (ended()) { reply(res, 410, { error: "ended" }); return; }
        ticket = randomBytes(32).toString("base64url"); consumed = false; ticketExpires = Date.now() + 15_000;
        reply(res, 200, { ticket, password: options.password, expiresAt, resumeUrl: options.resumeUrl }); return;
      }
      if (!ticket || input.ticket !== ticket) { reply(res, 403, { error: "unauthorized" }); return; }
      if (req.url === "/api/viewport") {
        if (resizing || !consumed || viewer?.readyState !== WebSocket.OPEN) { reply(res, 409, { error: "viewer_required" }); return; }
        await resize(); reply(res, ended() ? 410 : 200, { status: ended() ? "ended" : "resized" }); return;
      }
      if (input.mode !== "share" && input.mode !== "private") { reply(res, 400, { error: "invalid_request" }); return; }
      if (input.mode === "share" && (!consumed || viewer?.readyState !== WebSocket.OPEN)) { reply(res, 409, { error: "viewer_required" }); return; }
      reply(res, 200, { status: "handed_back" });
      finish({ status: "handed_back", mode: input.mode });
    } finally { for (const chunk of chunks) chunk.fill(0); }
  };
  const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent && !res.destroyed) reply(res, 400, { error: "invalid_request" }); else res.destroy(); }); });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxConnections = 16;
  server.on("upgrade", (req, socket, head) => {
    if (!permit() || ended() || req.url !== "/socket" || req.headers.origin !== options.origin || sockets.clients.size >= 2) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      let upstream: WebSocket | undefined, authenticated = false;
      const timer = setTimeout(() => ws.terminate(), 3_000);
      ws.on("error", () => ws.terminate());
      ws.on("close", () => { clearTimeout(timer); upstream?.terminate(); if (viewer === ws) viewer = undefined; });
      ws.on("message", (data, binary) => {
        if (ended()) { ws.terminate(); return; }
        if (!authenticated) {
          let input; try { if (binary || data.toString().length > 256) throw new Error(); input = JSON.parse(data.toString()); } catch { ws.terminate(); return; }
          if (!input || Object.keys(input).length !== 1 || !ticket || input.ticket !== ticket || consumed || viewer || Date.now() >= ticketExpires) { ws.terminate(); return; }
          consumed = true; authenticated = true; viewer = ws; clearTimeout(timer);
          // The client installs noVNC synchronously upon this acknowledgment.
          ws.send(JSON.stringify({ ready: true }));
          upstream = new WebSocket(`ws://127.0.0.1:${options.upstreamPort}/websockify`, ["binary"], { maxPayload: 16_000_000, perMessageDeflate: false, handshakeTimeout: 3_000 });
          upstream.on("message", (frame, isBinary) => {
            if (ended() || ws.readyState !== WebSocket.OPEN || !isBinary || ws.bufferedAmount > 8_000_000) { ws.terminate(); return; }
            ws.send(frame, { binary: true }, error => { if (error) ws.terminate(); });
          });
          upstream.on("error", () => ws.terminate()); upstream.on("close", () => ws.terminate());
        } else {
          if (!binary || upstream?.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 1_000_000) { ws.terminate(); return; }
          upstream.send(data, { binary: true }, error => { if (error) ws.terminate(); });
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  options.signal.addEventListener("abort", abort, { once: true });
  const expiry = setTimeout(() => finish({ status: "expired", mode: "private" }), Math.max(1, expiresAt - Date.now()));
  if (options.signal.aborted) abort();
  return { port: (server.address() as { port: number }).port, requestId, done,
    quarantine() {
      // Keep the port occupied if Serve teardown is uncertain. Releasing it could
      // expose an unrelated service that later receives the same ephemeral port.
      quarantined = true; abort(); clearTimeout(expiry); server.unref();
    },
    async close() {
      clearTimeout(expiry); options.signal.removeEventListener("abort", abort); abort();
      await done;
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => { const force = setTimeout(() => server.closeAllConnections(), 1_000); server.close(() => { clearTimeout(force); resolve(); }); });
    },
  };
}
