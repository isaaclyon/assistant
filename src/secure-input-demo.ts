import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

export const DEMO_DURATION_MS = 15 * 60_000;
const MAX_BODY = 12_000;
type DemoStatus = "pending" | "completed" | "cancelled";

/** Validate raw Telegram initData; never trust initDataUnsafe or return its fields. */
export function validateMiniAppIdentity(raw: string, token: string, userId: number, now: number): boolean {
  try {
    if (raw.length > MAX_BODY) return false;
    const fields = new URLSearchParams(raw);
    if (new Set(fields.keys()).size !== [...fields].length) return false;
    const hash = fields.get("hash") ?? "";
    if (!/^[a-f0-9]{64}$/.test(hash)) return false;
    fields.delete("hash");
    fields.sort();
    const key = createHmac("sha256", "WebAppData").update(token).digest();
    const expected = createHmac("sha256", key).update([...fields].map(([k, v]) => `${k}=${v}`).join("\n")).digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return false;
    const date = fields.get("auth_date") ?? "";
    if (!/^\d{10}$/.test(date)) return false;
    const age = now / 1000 - Number(date);
    if (age < -30 || age > 600) return false;
    const user: unknown = JSON.parse(fields.get("user") ?? "null");
    return typeof user === "object" && user !== null &&
      (user as { id?: unknown }).id === userId;
  } catch { return false; }
}

export async function startSecureInputDemo(options: {
  botToken: string;
  userId: number;
  origin: string;
  assetsDir?: string;
  now?: () => number;
  onTerminal: (status: "completed" | "cancelled") => void;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.origin !== options.origin || origin.username || origin.password) {
    throw new Error("Demo requires an HTTPS origin without a path");
  }
  if (!Number.isSafeInteger(options.userId) || options.userId <= 0 || !options.botToken) {
    throw new Error("Demo requires a paired private Telegram profile");
  }
  const assetsDir = options.assetsDir ?? join(process.cwd(), "web", "secure-input-demo");
  const assets = new Map(await Promise.all([
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ].map(async ([path, file, type]) => [path!, { type: type!, body: await readFile(join(assetsDir, file!)) }] as const)));
  const now = options.now ?? Date.now;
  const expiresAt = now() + DEMO_DURATION_MS;
  const requestId = randomBytes(24).toString("base64url");
  let status: DemoStatus = "pending";
  // A bounded global budget is sufficient for this one-person, one-request demo.
  let requestCount = 0;
  let windowStart = now();
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
  };
  const reply = (res: ServerResponse, code: number, result: object) => {
    res.writeHead(code, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(result));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (now() >= expiresAt) { reply(res, 410, { error: "expired" }); return; }
    if (now() - windowStart >= 60_000) { requestCount = 0; windowStart = now(); }
    if (++requestCount > 120) { reply(res, 429, { error: "try_later" }); return; }
    if (req.method === "GET") {
      if (req.url === "/healthz") { reply(res, 200, { status: "ok" }); return; }
      const asset = assets.get(req.url ?? "");
      if (asset) { res.writeHead(200, { ...headers, "content-type": asset.type }); res.end(asset.body); return; }
    }
    if (req.method !== "POST" || !["/api/auth", "/api/submit", "/api/cancel"].includes(req.url ?? "")) {
      reply(res, 404, { error: "not_found" }); return;
    }
    if (req.headers.origin !== options.origin) { reply(res, 403, { error: "unauthorized" }); return; }
    if (req.headers["content-type"] !== "application/json") { reply(res, 415, { error: "json_required" }); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { reply(res, 413, { error: "too_large" }); return; }
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { reply(res, 400, { error: "invalid_request" }); return; }
    if (!body || typeof body !== "object" || Array.isArray(body)) { reply(res, 400, { error: "invalid_request" }); return; }
    const input = body as Record<string, unknown>;
    const allowed = req.url === "/api/submit" ? ["requestId", "initData", "code"] : ["requestId", "initData"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) { reply(res, 400, { error: "invalid_request" }); return; }
    if (input.requestId !== requestId || typeof input.initData !== "string" ||
        !validateMiniAppIdentity(input.initData, options.botToken, options.userId, now())) {
      reply(res, 403, { error: "unauthorized" }); return;
    }
    // Recheck after reading the body: a slow request must not outlive its lease.
    if (now() >= expiresAt) { reply(res, 410, { error: "expired" }); return; }
    if (req.url === "/api/auth") { reply(res, 200, { status }); return; }
    if (status !== "pending") { reply(res, 409, { error: "already_used" }); return; }
    if (req.url === "/api/submit" && input.code !== "123456") { reply(res, 400, { error: "demo_code_only" }); return; }
    status = req.url === "/api/submit" ? "completed" : "cancelled";
    reply(res, 200, { status });
    // Only a closed status enum crosses the completion boundary. No request body.
    try { options.onTerminal(status); } catch { /* Already consumed; never retry submission. */ }
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) reply(res, 400, { error: "invalid_request" });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const port = (server.address() as { port: number }).port;
  return {
    port, requestId, expiresAt,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
