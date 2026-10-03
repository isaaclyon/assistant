import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { validateMiniAppIdentity } from "./secure-input-demo.js";
import { validProtectedValues, type ProtectedInputRequest } from "./protected-browser.js";

export type PrivateInputStatus = "submitted" | "cancelled" | "expired" | "failed";
export async function startPrivateInputServer(options: {
  origin: string; botToken: string; userId: number; request: ProtectedInputRequest;
  assetsDir: string; signal: AbortSignal; submit(values: string[]): Promise<void | Array<"password" | "code">>;
  durationMs?: number;
}) {
  const duration = options.durationMs ?? 10 * 60_000;
  const expiresAt = Date.now() + duration;
  const requestId = randomBytes(24).toString("base64url");
  let step = randomBytes(24).toString("base64url");
  let fields = options.request.fields;
  const usedKinds = new Set(fields.map(({ kind }) => kind));
  let state: PrivateInputStatus | "pending" | "processing" = "pending";
  let settle!: (status: PrivateInputStatus) => void;
  const done = new Promise<PrivateInputStatus>((resolve) => { settle = resolve; });
  const finish = (status: PrivateInputStatus) => { state = status; settle(status); };
  const abort = () => { if (state === "pending") finish("cancelled"); };
  const metadata = () => ({ status: state, origin: new URL(options.request.pageUrl).origin,
    fields: fields.map(({ kind }) => kind), step, ...(options.request.flow ? { flow: options.request.flow } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const files = new Map(await Promise.all([
    ["/", "index.html", "text/html"], ["/app.js", "app.js", "text/javascript"], ["/style.css", "style.css", "text/css"],
  ].map(async ([url, file, type]) => [url!, { type: type!, body: await readFile(join(options.assetsDir, file!)) }] as const)));
  const headers = {
    "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
  };
  const reply = (res: ServerResponse, code: number, data: object) => {
    res.writeHead(code, { ...headers, "content-type": "application/json" }); res.end(JSON.stringify(data));
  };
  let count = 0, windowStart = Date.now();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (Date.now() - windowStart > 60_000) { count = 0; windowStart = Date.now(); }
    if (++count > 120) { reply(res, 429, { error: "try_later" }); return; }
    if (req.method === "GET") {
      if (req.url === "/healthz") { reply(res, 200, { status: "ok" }); return; }
      const file = files.get(req.url ?? "");
      if (file) { res.writeHead(200, { ...headers, "content-type": `${file.type}; charset=utf-8` }); res.end(file.body); return; }
    }
    if (req.method !== "POST" || !["/api/auth", "/api/submit", "/api/cancel"].includes(req.url ?? "")) { reply(res, 404, { error: "not_found" }); return; }
    if (req.headers.origin !== options.origin || req.headers["content-type"] !== "application/json") { reply(res, 403, { error: "unauthorized" }); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let input: Record<string, unknown> | undefined;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 24_000) { reply(res, 413, { error: "too_large" }); return; }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      try { input = JSON.parse(body.toString("utf8")); } finally { body.fill(0); }
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["requestId", "initData", ...(req.url === "/api/submit" ? ["values", "step"] : [])].includes(key))) { reply(res, 400, { error: "invalid_request" }); return; }
      if (input.requestId !== requestId || typeof input.initData !== "string" ||
          !validateMiniAppIdentity(input.initData, options.botToken, options.userId, Date.now())) { reply(res, 403, { error: "unauthorized" }); return; }
      if (Date.now() >= expiresAt || options.signal.aborted) { reply(res, 410, { error: "expired" }); return; }
      if (req.url === "/api/auth") {
        reply(res, 200, metadata()); return;
      }
      if (state !== "pending") { reply(res, 409, { error: "already_used" }); return; }
      if (req.url === "/api/cancel") { reply(res, 200, { status: "cancelled" }); finish("cancelled"); return; }
      if (input.step !== step) { reply(res, 409, { error: "stale_step" }); return; }
      if (!validProtectedValues({ ...options.request, fields }, input.values)) { reply(res, 400, { error: "invalid_fields" }); return; }
      state = "processing"; // Consume before awaiting browser work; retries never fill twice.
      try {
        const next = await options.submit(input.values);
        const ended = options.signal.aborted ? "cancelled" : Date.now() >= expiresAt ? "expired" : undefined;
        if (ended) { reply(res, 200, { status: ended }); finish(ended); return; }
        if (next !== undefined) {
          if (options.request.flow !== "opentable" || !Array.isArray(next) || next.length !== 1 ||
              !["password", "code"].includes(next[0]!) || usedKinds.has(next[0]!) || usedKinds.size >= 3) throw new Error();
          usedKinds.add(next[0]!);
          fields = next.map((kind) => ({ kind, selector: "" }));
          step = randomBytes(24).toString("base64url"); state = "pending";
          reply(res, 200, metadata());
        } else { reply(res, 200, { status: "submitted" }); finish("submitted"); }
      } catch {
        reply(res, 409, { error: "page_changed_or_unavailable" }); finish("failed");
      }
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      if (input) { input.values = undefined; input.initData = undefined; }
    }
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent && !res.destroyed) reply(res, 400, { error: "invalid_request" }); });
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  timer = setTimeout(() => { if (state === "pending") finish("expired"); }, duration);
  return {
    port: (server.address() as { port: number }).port, requestId, expiresAt, done,
    async close() {
      clearTimeout(timer); options.signal.removeEventListener("abort", abort);
      if (state === "processing") await done;
      if (state === "pending") finish("cancelled");
      // Let the final response flush before ending the owned proxy. Bound shutdown
      // even if another tailnet client leaves an incomplete request open.
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), 1_000);
        server.close(() => { clearTimeout(force); resolve(); });
      });
    },
  };
}
