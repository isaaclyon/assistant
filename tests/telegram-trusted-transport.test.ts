import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

const key = Symbol.for("pi.bridge.trustedTelegramFetch");
const globals = globalThis as typeof globalThis & { [key]?: typeof fetch };
afterEach(() => { delete globals[key]; vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("pinned fork trusted transport seam", () => {
  it("uses the host transport for ordinary calls and identity lookup", async () => {
    const api = await import(pathToFileURL(join(dirname(resolveTelegramExtensionPath()), "lib/telegram-api.ts")).href);
    const direct = vi.fn(); vi.stubGlobal("fetch", direct);
    const proxy = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { id: 123 } })));
    globals[key] = proxy;
    expect(await api.callTelegram("0:surrogate", "getMe", {})).toEqual({ id: 123 });
    expect(await api.fetchTelegramBotIdentity("0:surrogate")).toEqual({ ok: true, result: { id: 123 } });
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(direct).not.toHaveBeenCalled();
  });
  it("fails closed when configured but the host transport has not been installed", async () => {
    const api = await import(pathToFileURL(join(dirname(resolveTelegramExtensionPath()), "lib/telegram-api.ts")).href);
    vi.stubEnv("PI_TELEGRAM_TRUSTED_SOCKET", "/synthetic/broker.sock");
    const direct = vi.fn(); vi.stubGlobal("fetch", direct);
    await expect(api.fetchTelegramBotIdentity("0:surrogate")).rejects.toThrow(/not installed/);
    expect(direct).not.toHaveBeenCalled();
  });
});
