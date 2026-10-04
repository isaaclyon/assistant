import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeInstanceConfig } from "../src/config.js";
const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: h.spawn }));
import { privateLoginCredential } from "../src/private-login-credential.js";
const config = { resourceRoot: "/release", credentialScope: "builder" } as BridgeInstanceConfig;
describe("private saved login credentials", () => {
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
  it("uses only the instance scope and keeps provider output inside the host", async () => {
    vi.stubEnv("PI_TELEGRAM_CREDENTIAL_SCOPE", "other-instance"); vi.stubEnv("UNRELATED_SECRET", "must-not-inherit");
    let input = "";
    h.spawn.mockImplementation(() => {
      const stdin = new PassThrough(); stdin.on("data", chunk => input += chunk);
      const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), kill: vi.fn() });
      stdin.on("finish", () => { child.stdout.end(JSON.stringify({ protocol: "agent-browser.plugin.v1", success: true, credential: { url: "https://example.com/signin", username: "synthetic-user", password: "synthetic-secret" } })); child.emit("close", 0); });
      return child;
    });
    expect(await privateLoginCredential(config, "approved-item", "https://example.com/signin", new AbortController().signal)).toEqual({ username: "synthetic-user", password: "synthetic-secret" });
    const [, args, options] = h.spawn.mock.calls[0]!;
    expect(args).toEqual(["/release/.pi/skills/agent-browser/scripts/onepassword-credentials.mjs"]);
    expect(options.env.PI_TELEGRAM_CREDENTIAL_SCOPE).toBe("builder"); expect(options.env.UNRELATED_SECRET).toBeUndefined();
    expect(JSON.parse(input).request).toEqual({ itemRef: "approved-item", url: "https://example.com/signin", originPolicy: "exact" });
    expect(JSON.stringify(h.spawn.mock.calls)).not.toContain("synthetic-secret");
  });
  it("turns provider errors into an unavailable result and does not start after cancellation", async () => {
    h.spawn.mockImplementation(() => { const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() }); queueMicrotask(() => child.emit("error", new Error("synthetic-secret"))); return child; });
    expect(await privateLoginCredential(config, "item", "https://example.com/", new AbortController().signal)).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    expect(await privateLoginCredential(config, "item", "https://example.com/", controller.signal)).toBeUndefined();
    expect(h.spawn).toHaveBeenCalledOnce();
  });
  it.skipIf(process.platform !== "linux")("kills the private worker and its descendants on cancellation", async () => {
    const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    h.spawn.mockImplementation((...args: any[]) => (original.spawn as any)(...args));
    const root = await mkdtemp(join(tmpdir(), "private-credential-test-")), controller = new AbortController();
    const directory = join(root, ".pi/skills/agent-browser/scripts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "onepassword-credentials.mjs"), `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(new URL('./worker.pid',import.meta.url),String(child.pid));setInterval(()=>{},1000);`);
    const pending = privateLoginCredential({ ...config, resourceRoot: root }, "synthetic", "https://example.com/", controller.signal);
    try {
      let pid = 0;
      await vi.waitFor(async () => { pid = Number(await readFile(join(directory,"worker.pid"),"utf8")); expect(pid).toBeGreaterThan(0); });
      controller.abort(); expect(await pending).toBeUndefined();
      await vi.waitFor(async () => {
        const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
        expect(!state || /\) Z /.test(state)).toBe(true);
      });
    } finally { controller.abort(); await pending; await rm(root, { recursive: true, force: true }); }
  });
});
