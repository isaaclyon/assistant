import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeInstanceConfig } from "../src/config.js";
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: h.exec }));
import { privateLoginCredential } from "../src/private-login-credential.js";
const config = { resourceRoot: "/release", credentialScope: "builder" } as BridgeInstanceConfig;
describe("private saved login credentials", () => {
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
  it("uses only the instance scope and keeps provider output inside the host", async () => {
    vi.stubEnv("PI_TELEGRAM_CREDENTIAL_SCOPE", "other-instance"); vi.stubEnv("UNRELATED_SECRET", "must-not-inherit");
    let input = "";
    h.exec.mockImplementation((_file, _args, _options, callback) => {
      const stdin = new PassThrough(); stdin.on("data", chunk => input += chunk);
      stdin.on("finish", () => callback(null, JSON.stringify({ protocol: "agent-browser.plugin.v1", success: true, credential: { url: "https://example.com/signin", username: "synthetic-user", password: "synthetic-secret" } })));
      return { stdin };
    });
    expect(await privateLoginCredential(config, "approved-item", "https://example.com/signin", new AbortController().signal)).toEqual({ username: "synthetic-user", password: "synthetic-secret" });
    const [, args, options] = h.exec.mock.calls[0]!;
    expect(args).toEqual(["/release/.pi/skills/agent-browser/scripts/onepassword-credentials.mjs"]);
    expect(options.env.PI_TELEGRAM_CREDENTIAL_SCOPE).toBe("builder"); expect(options.env.UNRELATED_SECRET).toBeUndefined();
    expect(JSON.parse(input).request).toEqual({ itemRef: "approved-item", url: "https://example.com/signin", originPolicy: "exact" });
    expect(JSON.stringify(h.exec.mock.calls)).not.toContain("synthetic-secret");
  });
  it("turns provider errors into an unavailable result and does not start after cancellation", async () => {
    h.exec.mockImplementation((_file,_args,_options,callback) => { queueMicrotask(() => callback(new Error("synthetic-secret"), "")); return {}; });
    expect(await privateLoginCredential(config, "item", "https://example.com/", new AbortController().signal)).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    expect(await privateLoginCredential(config, "item", "https://example.com/", controller.signal)).toBeUndefined();
    expect(h.exec).toHaveBeenCalledOnce();
  });
});
