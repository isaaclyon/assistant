#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL = "agent-browser.plugin.v1";
const SCOPES = new Set([
  "isaac-personal",
  "emma-personal",
  "household",
  "engineering",
]);
const PRINCIPAL_SCOPES = {
  isaac: "isaac-personal",
  emma: "emma-personal",
  household: "household",
  engineering: "engineering",
};

function configRoot() {
  return (
    process.env.PI_TELEGRAM_BRIDGE_CONFIG_ROOT ||
    join(homedir(), ".config", "pi-telegram-bridge")
  );
}

function credentialPaths(scope) {
  const directory = join(configRoot(), "onepassword");
  return {
    directory,
    configPath: join(directory, `${scope}.json`),
    tokenPath: join(directory, `${scope}.token`),
  };
}

function response(value) {
  process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, ...value })}\n`);
}

function unavailable(message) {
  response({
    success: false,
    error: { code: "CREDENTIAL_UNAVAILABLE", message },
  });
}

function resolvedScope() {
  const declared = process.env.PI_TELEGRAM_CREDENTIAL_SCOPE?.trim();
  if (declared) return SCOPES.has(declared) ? declared : undefined;
  return PRINCIPAL_SCOPES[process.env.PI_TELEGRAM_PRINCIPAL?.trim()];
}

async function readPrivateFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new Error("1Password credential paths must be regular files");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("1Password credential files must have mode 0600");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error("1Password credential files must be owned by the service user");
  }
  return await readFile(path, "utf8");
}

function parseTargetUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Credential login URL is invalid");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("Credentials may only be used with HTTPS login URLs");
  }
  return url;
}

function normalizedHost(hostname) {
  const lower = hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function domainMatches(target, itemUrl) {
  let saved;
  try {
    saved = new URL(itemUrl);
  } catch {
    return false;
  }
  if (saved.protocol !== "https:") return false;
  const requestedHost = normalizedHost(target.hostname);
  const savedHost = normalizedHost(saved.hostname);
  return requestedHost === savedHost || requestedHost.endsWith(`.${savedHost}`);
}

function fieldValue(item, purpose, names) {
  if (!Array.isArray(item.fields)) return undefined;
  const field = item.fields.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    if (String(candidate.purpose || "").toUpperCase() === purpose) return true;
    const id = String(candidate.id || "").toLowerCase();
    const label = String(candidate.label || "").toLowerCase();
    return names.includes(id) || names.includes(label);
  });
  return typeof field?.value === "string" && field.value ? field.value : undefined;
}

async function readStdin(limit) {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > limit) throw new Error("Input is too large");
  }
  return source;
}

async function resolveCredential() {
  const input = await readStdin(64 * 1024);
  let message;
  try {
    message = JSON.parse(input);
  } catch {
    throw new Error("Credential request is not valid JSON");
  }
  if (
    message?.protocol !== PROTOCOL ||
    message?.type !== "credential.resolve" ||
    message?.capability !== "credential.read"
  ) {
    throw new Error("Unsupported credential request");
  }
  const itemRef = message.request?.itemRef;
  if (
    typeof itemRef !== "string" ||
    itemRef.length === 0 ||
    itemRef.length > 200 ||
    itemRef.startsWith("-") ||
    /[\0\r\n]/.test(itemRef)
  ) {
    throw new Error("Credential item reference is invalid");
  }
  const target = parseTargetUrl(message.request?.url);
  const scope = resolvedScope();
  if (!scope) throw new Error("Credential scope is unavailable");
  const paths = credentialPaths(scope);
  const [configSource, tokenSource] = await Promise.all([
    readPrivateFile(paths.configPath),
    readPrivateFile(paths.tokenPath),
  ]);
  let config;
  try {
    config = JSON.parse(configSource);
  } catch {
    throw new Error("1Password provider configuration is invalid");
  }
  if (
    config?.version !== 1 ||
    typeof config.vault !== "string" ||
    !config.vault.trim() ||
    config.vault.length > 200 ||
    config.vault.startsWith("-") ||
    /[\0\r\n]/.test(config.vault)
  ) {
    throw new Error("1Password provider configuration is invalid");
  }
  const token = tokenSource.trim();
  if (!token || /[\0\r\n]/.test(token)) {
    throw new Error("1Password service-account token is invalid");
  }

  const op = process.env.ONEPASSWORD_CLI || "op";
  const result = spawnSync(
    op,
    ["item", "get", itemRef, "--vault", config.vault, "--format", "json"],
    {
      encoding: "utf8",
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("1Password item lookup failed");
  }
  let item;
  try {
    item = JSON.parse(result.stdout);
  } catch {
    throw new Error("1Password returned an invalid item");
  }
  if (String(item?.category || "").toUpperCase() !== "LOGIN") {
    throw new Error("1Password item must be a Login item");
  }
  const urls = Array.isArray(item.urls) ? item.urls : [];
  if (
    !urls.some(
      (entry) =>
        entry && typeof entry.href === "string" && domainMatches(target, entry.href),
    )
  ) {
    throw new Error("Login URL does not match the 1Password item's website domain");
  }
  const username = fieldValue(item, "USERNAME", ["username", "email"]);
  const password = fieldValue(item, "PASSWORD", ["password"]);
  if (!username || !password) {
    throw new Error("1Password Login item is missing a username or password");
  }
  response({
    success: true,
    credential: { username, password, url: target.href },
  });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function stdinText() {
  return (await readStdin(16 * 1024)).replace(/[\r\n]+$/, "");
}

async function hiddenToken() {
  if (!process.stdin.isTTY) {
    throw new Error("Token setup requires a terminal");
  }
  const terminal = spawnSync("stty", ["-echo"], { stdio: "inherit" });
  if (terminal.status !== 0) {
    throw new Error("Unable to disable terminal echo");
  }
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    process.stderr.write("Paste 1Password service-account token: ");
    const token = await new Promise((resolve) => lines.once("line", resolve));
    process.stderr.write("\n");
    return token;
  } finally {
    lines.close();
    spawnSync("stty", ["echo"], { stdio: "inherit" });
  }
}

async function atomicPrivateWrite(path, contents) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function setup(args) {
  const scope = option(args, "--scope");
  const vault = option(args, "--vault");
  if (!scope || !SCOPES.has(scope)) throw new Error("setup requires a valid --scope");
  if (
    !vault ||
    vault.length > 200 ||
    vault.startsWith("-") ||
    /[\0\r\n]/.test(vault)
  ) {
    throw new Error("setup requires a valid --vault");
  }
  const token = args.includes("--token-stdin") ? await stdinText() : await hiddenToken();
  if (!token || token.length > 16 * 1024 || /[\0\r\n]/.test(token)) {
    throw new Error("Token is empty or invalid");
  }
  const paths = credentialPaths(scope);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await atomicPrivateWrite(paths.tokenPath, token);
  await atomicPrivateWrite(
    paths.configPath,
    `${JSON.stringify({ version: 1, vault })}\n`,
  );
  process.stdout.write(`Installed private 1Password credentials for ${scope}.\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "setup") {
  setup(args).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  resolveCredential().catch((error) =>
    unavailable(error instanceof Error ? error.message : "Credential resolution failed"),
  );
}
