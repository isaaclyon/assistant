import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOpenAIEmbedder, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../src/openai-embeddings.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function config() {
  const root = await mkdtemp(join(tmpdir(), "embedding-key-"));
  roots.push(root);
  const path = join(root, "key");
  await writeFile(path, "synthetic-secret\n", { mode: 0o600 });
  return { PI_TELEGRAM_OPENAI_API_KEY_FILE: path };
}
const vector = (axis: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === axis ? 2 : 0);
const response = (data: unknown) => new Response(JSON.stringify({ model: EMBEDDING_MODEL, data }));

it("uses the fixed OpenAI contract and reorders and normalizes returned vectors", async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response([
    { index: 1, embedding: vector(1) }, { index: 0, embedding: vector(0) },
  ]));
  const embed = createOpenAIEmbedder({ env: await config(), fetcher })!;
  const result = await embed(["query", "note"]);
  expect(result[0]![0]).toBe(1);
  expect(result[1]![1]).toBe(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/embeddings");
  expect(init.redirect).toBe("error");
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.headers).toMatchObject({ authorization: "Bearer synthetic-secret" });
  expect(JSON.parse(String(init.body))).toEqual({
    model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, encoding_format: "float", input: ["query", "note"],
  });
});

it("disables without configuration and rejects unsafe key files before networking", async () => {
  const fetcher = vi.fn();
  expect(createOpenAIEmbedder({ env: {}, fetcher })).toBeUndefined();
  const env = await config();
  await chmod(env.PI_TELEGRAM_OPENAI_API_KEY_FILE, 0o644);
  await expect(createOpenAIEmbedder({ env, fetcher })!(["note"])).rejects.toThrow("unavailable or unsafe");
  await chmod(env.PI_TELEGRAM_OPENAI_API_KEY_FILE, 0o600);
  const link = `${env.PI_TELEGRAM_OPENAI_API_KEY_FILE}-link`;
  await symlink(env.PI_TELEGRAM_OPENAI_API_KEY_FILE, link);
  await expect(createOpenAIEmbedder({ env: { PI_TELEGRAM_OPENAI_API_KEY_FILE: link }, fetcher })!(["note"]))
    .rejects.toThrow("unavailable or unsafe");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  [{ index: 0, embedding: [1] }],
  [{ index: 0, embedding: Array(EMBEDDING_DIMENSIONS).fill(0) }],
  [{ index: 2, embedding: vector(0) }],
  [{ index: 0, embedding: vector(0) }, { index: 0, embedding: vector(1) }],
])("rejects malformed or mismatched embeddings", async (...items) => {
  const embed = createOpenAIEmbedder({ env: await config(), fetcher: async () => response(items) })!;
  await expect(embed(["note"])).rejects.toThrow("OpenAI embeddings unavailable");
});

it("falls back promptly on provider errors without retries or private error bodies", async () => {
  const fetcher = vi.fn(async () => new Response("private provider payload", { status: 429 }));
  await expect(createOpenAIEmbedder({ env: await config(), fetcher })!(["note"]))
    .rejects.toThrow(/^OpenAI embeddings unavailable$/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("aborts slow requests and rejects unbounded inputs/responses", async () => {
  const env = await config();
  const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  }));
  await expect(createOpenAIEmbedder({ env, fetcher, timeoutMs: 10 })!(["note"]))
    .rejects.toThrow("OpenAI embeddings unavailable");
  await expect(createOpenAIEmbedder({ env, fetcher })!(["a".repeat(6001)])).rejects.toThrow("Invalid embedding inputs");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(createOpenAIEmbedder({ env, fetcher: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)) })!(["note"]))
    .rejects.toThrow("OpenAI embeddings unavailable");
});
