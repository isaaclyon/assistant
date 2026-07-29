import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { normalizePhoneNumber } from "../../../../web/messages/messages-link.js";

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 16 * 1024;

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Messages base URL must be a credential-free HTTPS origin");
  }
  return url;
}

export function buildMessageLink(baseUrl, proposed) {
  const url = normalizeBaseUrl(baseUrl);
  const phoneNumber = normalizePhoneNumber(proposed.to);
  if (!phoneNumber) throw new Error("Invalid phone number");
  if (typeof proposed.label !== "string" || proposed.label.length > 80) {
    throw new Error("Label must be at most 80 characters");
  }
  if (typeof proposed.body !== "string" || proposed.body.length > 5000) {
    throw new Error("Body must be at most 5,000 characters");
  }

  const fragment = new URLSearchParams({
    to: phoneNumber,
    label: proposed.label,
    body: proposed.body,
  });
  url.hash = fragment.toString();
  return url.href;
}

async function discoverBaseUrl(env) {
  if (env.PI_TELEGRAM_MESSAGES_BASE_URL?.trim()) {
    return normalizeBaseUrl(env.PI_TELEGRAM_MESSAGES_BASE_URL.trim()).href;
  }
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  });
  const status = JSON.parse(stdout);
  const dnsName = status?.Self?.DNSName;
  if (typeof dnsName !== "string" || !dnsName.endsWith(".ts.net.")) {
    throw new Error("Could not discover the tailnet HTTPS hostname");
  }
  return `https://${dnsName.slice(0, -1)}:8443/`;
}

async function readInput(stream) {
  let input = "";
  for await (const chunk of stream) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("Input is too large");
  }
  return JSON.parse(input);
}

async function main() {
  const proposed = await readInput(process.stdin);
  const baseUrl = await discoverBaseUrl(process.env);
  process.stdout.write(`${JSON.stringify({ url: buildMessageLink(baseUrl, proposed) })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
