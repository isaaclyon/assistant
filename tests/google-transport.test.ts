import childProcess, { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const transport = await import(pathToFileURL(join(import.meta.dirname, "../.pi/lib/google-transport.ts")).href);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "google-transport-"));
  roots.push(root);
  const passwordFile = join(root, "password");
  await writeFile(passwordFile, "synthetic-password", { mode: 0o600 });
  return { binary: process.execPath, passwordFile, gogHome: root, args: ["-e", "process.stdout.write('{}')"] };
}

describe.each([
  {
    operation: "rich details",
    request: (apiKeyFile: string, signal?: AbortSignal) => transport.fetchPlaceDetails({
      apiKeyFile, fields: "rich", placeId: "test", ...(signal ? { signal } : {}),
    }),
  },
  {
    operation: "candidate search",
    request: (apiKeyFile: string, signal?: AbortSignal) => transport.fetchPlaceSearch({
      apiKeyFile, fields: "candidates", query: "coffee", maxResults: 15, ...(signal ? { signal } : {}),
    }),
  },
])("Places HTTPS safeguards: $operation", ({ request }) => {
  it("does not fetch for an already cancelled request or an unavailable key", async () => {
    const options = await fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(request(options.passwordFile, AbortSignal.abort())).rejects.toThrow(/^Google Workspace command failed$/);
    await expect(request(join(options.gogHome, "missing-secret"))).rejects.toThrow(/^Google Workspace command failed$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["upstream failure", () => new Response("private upstream body", { status: 500 })],
    ["malformed JSON", () => new Response("private malformed body")],
    ["oversized content length", () => new Response("{}", { headers: { "content-length": "65537" } })],
    ["oversized stream", () => new Response(new Uint8Array(65537))],
    ["missing body", () => new Response(null)],
  ] as const)("redacts %s", async (_name, response) => {
    const options = await fixture();
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(request(options.passwordFile)).rejects.toThrow(/^Google Workspace command failed$/);
  });

  it.each(["cancellation", "timeout"])("aborts an in-flight fetch on %s", async (reason) => {
    const options = await fixture();
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetch = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("private fetch failure")), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const pending = request(options.passwordFile, caller.signal);
    const outcome = expect(pending).rejects.toThrow(/^Google Workspace command failed$/);
    await expect.poll(() => fetch.mock.calls.length).toBe(1);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    (reason === "timeout" ? timeout : caller).abort();
    await outcome;
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  });
});

it("does not spawn a child for an already cancelled request", async () => {
  const options = await fixture();
  const spawn = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  await expect(transport.runGogJson({ ...options, signal: AbortSignal.abort() }))
    .rejects.toThrow("Google Workspace command failed");
  expect(spawn.mock.calls.length).toBe(0);
});

it("redacts setup paths and malformed HTTPS response bodies at the transport boundary", async () => {
  const options = await fixture();
  for (const change of [{ binary: join(options.gogHome, "missing-binary") }, { passwordFile: join(options.gogHome, "missing-secret") }]) {
    await expect(transport.runGogJson({ ...options, ...change })).rejects.toThrow(/^Google Workspace command failed$/);
  }
  await expect(transport.fetchPlaceDetails({ apiKeyFile: join(options.gogHome, "missing-secret"), fields: "rich", placeId: "test" }))
    .rejects.toThrow(/^Google Workspace command failed$/);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private-response-body", { status: 200 })));
  await expect(transport.fetchPlaceDetails({ apiKeyFile: options.passwordFile, fields: "rich", placeId: "test" }))
    .rejects.toThrow(/^Google Workspace command failed$/);
});

it.skipIf(process.platform === "win32").each(["cancellation", "timeout"])("kills credential-bearing descendants on %s", async (reason) => {
  const options = await fixture();
  const pidFile = join(options.gogHome, "descendant.pid");
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setInterval(() => {}, 1000)`;
  const abort = new AbortController();
  const result = transport.runGogJson({ ...options, args: ["-e", parent], signal: abort.signal, timeoutMs: reason === "timeout" ? 1500 : 5000 });
  const outcome = result.catch((error: unknown) => error);
  let pid: number | undefined;
  try {
    await expect.poll(async () => {
      try { pid = Number(await readFile(pidFile, "utf8")); return Number.isSafeInteger(pid) && pid > 0; }
      catch { return false; }
    }, { timeout: 2000 }).toBe(true);
    if (reason === "cancellation") abort.abort();
    expect(await outcome).toEqual(new Error("Google Workspace command failed"));
    await expect.poll(() => {
      try { return execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z"); }
      catch { return true; }
    }, { timeout: 1000 }).toBe(true);
  } finally {
    abort.abort();
    await outcome;
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
});
