import { chmod, lstat } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { dirname, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TrustedTelegramTransport } from "./trusted-telegram-transport.js";
import type { ApprovedCredentialBroker } from "./approved-credential-broker.js";

const maxBody = 52 * 1024 * 1024;
const transportKey = Symbol.for("pi.bridge.trustedTelegramFetch");
type TransportGlobals = typeof globalThis & { [transportKey]?: typeof fetch };

/** A dedicated broker-owned directory (0750, runtime group) protects the socket
 * from replacement. The socket's group grants exactly the selected runtime IPC
 * access; privileged provisioning validates group membership independently. */
export async function serveTrustedTelegram(socketPath: string, transport: TrustedTelegramTransport, credentials?: ApprovedCredentialBroker): Promise<Server> {
  if (!isAbsolute(socketPath)) throw new Error("Trusted socket path must be absolute");
  const parent = await lstat(dirname(socketPath));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) {
    throw new Error("Trusted socket directory is not protected");
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method !== "POST" || !incoming.url || incoming.url.includes("?") || incoming.url.includes("%")) throw new Error();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > maxBody) throw new Error();
        chunks.push(Buffer.from(chunk));
      }
      let response: Response;
      if (incoming.url.startsWith("/file/")) {
        if (size !== 0) throw new Error();
        response = await transport.download(incoming.url.slice(6));
      } else {
        const match = /^\/api\/([A-Za-z]+)$/.exec(incoming.url);
        if (!match) throw new Error();
        const contentType = incoming.headers["content-type"] ?? "application/json";
        const body = Buffer.concat(chunks);
        const decoded = contentType.startsWith("multipart/form-data;")
          ? await new Response(body, { headers: { "content-type": contentType } }).formData()
          : contentType === "application/json" ? JSON.parse(body.toString("utf8") || "{}") as unknown : null;
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
        if (match[1]!.startsWith("credential")) {
          if (!credentials || decoded instanceof FormData) throw new Error();
          response = await credentials.call(match[1]!, decoded as Record<string, unknown>);
        } else response = await transport.runtimeCall(match[1]!, decoded as FormData | Record<string, unknown>);
      }
      outgoing.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/octet-stream" });
      if (response.body) await pipeline(Readable.fromWeb(response.body as never), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(403, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ ok: false, error_code: 403, description: "Trusted transport request unavailable" }));
    }
  });
  server.requestTimeout = 40_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 32;
  server.setTimeout(90_000, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  try { await chmod(socketPath, 0o660); }
  catch (error) { server.close(); throw error; }
  return server;
}

export function trustedTelegramFetch(socketPath: string): typeof fetch {
  if (!isAbsolute(socketPath)) throw new Error("Trusted socket path must be absolute");
  return async (input, init) => {
    const original = new Request(input, init);
    const url = new URL(original.url);
    const match = /^\/(file\/)?bot[^/]+\/([A-Za-z0-9_./-]+)$/.exec(url.pathname);
    if (url.origin !== "https://api.telegram.org" || url.search || url.hash || !match ||
        !["GET", "POST"].includes(original.method)) throw new Error("Invalid trusted Telegram request");
    const body = Buffer.from(await original.arrayBuffer());
    if (body.length > maxBody) throw new Error("Trusted Telegram upload is too large");
    return new Promise<Response>((resolve, reject) => {
      const call = httpRequest({ socketPath, path: `/${match[1] ? "file" : "api"}/${match[2]}`, method: "POST",
        headers: { "content-type": original.headers.get("content-type") ?? "application/json", "content-length": body.length },
        signal: AbortSignal.any([original.signal, AbortSignal.timeout(match[2]!.startsWith("credential") ? 75_000 : 40_000)]),
      }, incoming => {
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode ?? 502, headers: { "content-type": incoming.headers["content-type"] ?? "application/octet-stream" },
        }));
      });
      // Discard OS errors and request internals from model-facing failures.
      call.on("error", () => reject(new Error("Trusted Telegram transport unavailable")));
      call.end(body);
    });
  };
}

export function installTrustedTelegramFetch(socketPath: string): void {
  (globalThis as TransportGlobals)[transportKey] = trustedTelegramFetch(socketPath);
}
