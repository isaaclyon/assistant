import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_EMBEDDING_KEY_FILE_ENV = "PI_TELEGRAM_OPENAI_API_KEY_FILE";
export type EmbedTexts = (inputs: string[]) => Promise<number[][]>;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function normalizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS ||
      !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("Invalid embedding vector");
  }
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Invalid embedding vector");
  return value.map((n: number) => n / norm);
}

async function readKey(path: string): Promise<string> {
  const unavailable = new Error("OpenAI API key file is unavailable or unsafe");
  if (!isAbsolute(path)) throw unavailable;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 4096 ||
          (process.getuid && stat.uid !== process.getuid())) throw unavailable;
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const key = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (bytesRead > 4096 || !key || /\s/.test(key)) throw unavailable;
      return key;
    } finally {
      await file.close();
    }
  } catch {
    throw unavailable;
  }
}

/** Fixed endpoint, bounded batch/response, no retries on the interactive path. */
export function createOpenAIEmbedder({
  env = process.env,
  fetcher = fetch,
  timeoutMs = 2500,
}: {
  env?: NodeJS.ProcessEnv;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
} = {}): EmbedTexts | undefined {
  if (!env[OPENAI_EMBEDDING_KEY_FILE_ENV]?.trim()) return undefined;
  return async (inputs) => {
    if (inputs.length === 0 || inputs.length > 33 ||
        inputs.some((text) => !text.trim() || Buffer.byteLength(text) > 6000)) {
      throw new Error("Invalid embedding inputs");
    }
    const key = await readKey(env[OPENAI_EMBEDDING_KEY_FILE_ENV]?.trim() ?? "");
    try {
      const response = await fetcher("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, encoding_format: "float", input: inputs }),
      });
      if (!response.ok || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error("Embedding request failed");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Embedding response missing");
      const pieces: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_RESPONSE_BYTES) throw new Error("Embedding response too large");
          pieces.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const body = JSON.parse(Buffer.concat(pieces).toString("utf8")) as {
        model?: unknown; data?: Array<{ index?: unknown; embedding?: unknown }>;
      };
      if (body?.model !== EMBEDDING_MODEL || !Array.isArray(body.data) || body.data.length !== inputs.length) {
        throw new Error("Invalid embedding response");
      }
      const vectors = new Map<number, number[]>();
      for (const item of body.data) {
        if (!item || typeof item.index !== "number" || !Number.isInteger(item.index) ||
            item.index < 0 || item.index >= inputs.length || vectors.has(item.index)) {
          throw new Error("Invalid embedding response");
        }
        vectors.set(item.index, normalizeEmbedding(item.embedding));
      }
      return inputs.map((_, i) => vectors.get(i)!);
    } catch {
      // Never surface provider bodies, input text, or bearer credentials.
      throw new Error("OpenAI embeddings unavailable");
    }
  };
}
