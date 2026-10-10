/** Fixed endpoints are provisioned by the administrator outside the runtime's
 * namespace. The runtime owns only the short-lived authenticated listener. */
export interface PrivateBrowserEndpoint {
  origin: string;
  listen: { host: string; port: number };
}

export function privateBrowserEndpoint(
  kind: "input" | "takeover", env: NodeJS.ProcessEnv = process.env,
): PrivateBrowserEndpoint | undefined {
  const host = env.PI_PRIVATE_BROWSER_BIND_ADDRESS;
  const input = env.PI_PRIVATE_INPUT_ORIGIN, takeover = env.PI_PRIVATE_TAKEOVER_ORIGIN;
  if (!host && !input && !takeover && !env.PI_TELEGRAM_TRUSTED_SOCKET) return undefined;
  if (!host || !/^10\.(?:\d{1,3}\.){2}2$/.test(host) ||
      host.split(".").some(part => Number(part) > 255 || String(Number(part)) !== part)) {
    throw new Error("Private browser requires a configured namespace address");
  }
  for (const [value, port] of [[input, 8446], [takeover, 8447]] as const) {
    if (!value || !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net:\d+$/.test(value)) {
      throw new Error("Private browser requires configured private HTTPS origins");
    }
    const parsed = new URL(value);
    if (parsed.origin !== value || parsed.port !== String(port)) throw new Error("Invalid private browser origin");
  }
  return { origin: kind === "input" ? input! : takeover!, listen: { host, port: kind === "input" ? 8446 : 8447 } };
}
