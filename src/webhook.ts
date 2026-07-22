import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";

import type { JobsLogger, WebhookJob } from "./jobs.js";

const HOOK_PATH_PATTERN = /^\/hook\/([a-z0-9-]{1,64})$/;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BODY_IN_PROMPT_BYTES = 16 * 1024;
const PROMPT_HEADERS = ["content-type", "x-github-event"] as const;

export interface WebhookServerOptions {
  host: string;
  port: number;
  secret: string;
  getJob(id: string): WebhookJob | undefined;
  inject(prompt: string, job: WebhookJob): Promise<void>;
  logger: JobsLogger;
}

export interface WebhookServer {
  port: number;
  close(): Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

function hasValidBearer(header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length).trim(), secret);
}

function hasValidHmac(
  header: string | string[] | undefined,
  secret: string,
  body: Buffer,
): boolean {
  if (typeof header !== "string") return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return safeEqual(header, expected);
}

/** Resolves with the body, or undefined when it exceeds MAX_BODY_BYTES. */
function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        request.removeAllListeners("data");
        request.removeAllListeners("end");
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function respond(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(text);
}

export async function startWebhookServer({
  host,
  port,
  secret,
  getJob,
  inject,
  logger,
}: WebhookServerOptions): Promise<WebhookServer> {
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const match =
      request.method === "POST" ? HOOK_PATH_PATTERN.exec(request.url ?? "") : null;
    if (!match) {
      respond(response, 404, "not found");
      return;
    }
    const jobId = match[1] as string;
    const body = await readBody(request);
    if (body === undefined) {
      respond(response, 413, "payload too large");
      request.destroy();
      return;
    }
    // Authenticate before revealing whether the job id exists, so job ids
    // cannot be enumerated without a valid credential.
    const job = getJob(jobId);
    const authorized =
      hasValidBearer(request.headers.authorization, secret) ||
      (job?.hmacSecret !== undefined &&
        hasValidHmac(request.headers["x-hub-signature-256"], job.hmacSecret, body));
    if (!authorized) {
      respond(response, 401, "unauthorized");
      return;
    }
    if (!job) {
      respond(response, 404, "not found");
      return;
    }
    // Accept before the agent turn runs; senders like GitHub time out in ~10s.
    respond(response, 202, "accepted");
    const headerLines = PROMPT_HEADERS.flatMap((name) => {
      const value = request.headers[name];
      return typeof value === "string" ? [`${name}: ${value}`] : [];
    });
    const bodyText = body.subarray(0, MAX_BODY_IN_PROMPT_BYTES).toString("utf8");
    const prompt = [
      `Webhook '${job.id}' received.`,
      job.prompt,
      ...(headerLines.length > 0 ? [headerLines.join("\n")] : []),
      `Request body (truncated to ${MAX_BODY_IN_PROMPT_BYTES / 1024} KB):\n${bodyText}`,
    ].join("\n\n");
    try {
      await inject(prompt, job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Webhook '${job.id}' prompt injection failed: ${message}`);
    }
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Webhook request failed: ${message}`);
      if (!response.headersSent) respond(response, 500, "internal error");
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeIdleConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
