import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}

/** Refuse existing listeners and Funnel grants, including foreground overrides. */
export function assertDemoPortUnused(status: ServeConfig, port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid demo HTTPS port");
  for (const config of [status, ...Object.values(status.Foreground ?? {})]) {
    if (Object.hasOwn(config.TCP ?? {}, String(port)) ||
        Object.keys(config.Web ?? {}).some((key) => key.endsWith(`:${port}`)) ||
        Object.entries(config.AllowFunnel ?? {}).some(([key, allowed]) => allowed && key.endsWith(`:${port}`))) {
      throw new Error("Demo HTTPS port is already configured or permits Funnel");
    }
  }
}

export function isPrivateDemoProxy(status: ServeConfig, hostPort: string, target: string): boolean {
  const configs = [status, ...Object.values(status.Foreground ?? {})];
  if (configs.some((config) => config.AllowFunnel?.[hostPort])) return false;
  const handlers = configs.flatMap((config) => {
    const entry = config.Web?.[hostPort];
    return entry ? [entry.Handlers] : [];
  });
  return handlers.length === 1 && Object.keys(handlers[0] ?? {}).length === 1 && handlers[0]?.["/"]?.Proxy === target;
}

export async function readDemoTelegramProfile(agentDir: string, profile: string): Promise<{ botToken: string; userId: number }> {
  const path = join(agentDir, "telegram.json");
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
    throw new Error("Telegram configuration must be private and owned by this user");
  }
  const config = JSON.parse(await readFile(path, "utf8"));
  const selected = config.profiles?.[profile];
  if (typeof selected?.botToken !== "string" || !selected.botToken ||
      !Number.isSafeInteger(selected.allowedUserId) || selected.allowedUserId <= 0) {
    throw new Error("Demo requires a paired named Telegram profile");
  }
  return { botToken: selected.botToken, userId: selected.allowedUserId };
}

/** Fixed Bot API surface for this operator-launched prototype; never poll updates. */
export async function demoTelegramRequest(
  token: string,
  method: "sendMessage" | "editMessageText",
  body: object,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as { ok?: boolean; result?: { message_id?: number } };
    if (!response.ok || result.ok !== true || !Number.isSafeInteger(result.result?.message_id)) throw new Error();
    return result.result!.message_id!;
  } catch {
    // Do not expose response text or fetch errors, which may contain the bot URL.
    throw new Error("Telegram demo delivery failed");
  }
}
