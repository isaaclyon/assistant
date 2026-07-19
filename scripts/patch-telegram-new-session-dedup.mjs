import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "node_modules", "@llblab", "pi-telegram");
const commandsPath = join(packageRoot, "lib", "commands.ts");

const marker = "const TELEGRAM_NEW_SESSION_DEDUP_TTL_MS = 5 * 60_000;";
const helpers = `const TELEGRAM_NEW_SESSION_DEDUP_TTL_MS = 5 * 60_000;
const TELEGRAM_NEW_SESSION_DEDUP_KEY = Symbol.for(
  "pi-telegram.new-session-message-dedup",
);

function getTelegramNewSessionDedup(): Map<string, number> {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[TELEGRAM_NEW_SESSION_DEDUP_KEY];
  if (existing instanceof Map) return existing as Map<string, number>;
  const dedup = new Map<string, number>();
  store[TELEGRAM_NEW_SESSION_DEDUP_KEY] = dedup;
  return dedup;
}

function getTelegramNewSessionMessageKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as {
    chat?: { id?: unknown };
    message_id?: unknown;
  };
  if (
    typeof candidate.chat?.id !== "number" ||
    typeof candidate.message_id !== "number"
  ) {
    return undefined;
  }
  return \`\${candidate.chat.id}:\${candidate.message_id}\`;
}

function isDuplicateTelegramNewSessionMessage(message: unknown): boolean {
  const key = getTelegramNewSessionMessageKey(message);
  if (key === undefined) return false;
  const dedup = getTelegramNewSessionDedup();
  const now = Date.now();
  for (const [entryKey, expiresAt] of dedup) {
    if (expiresAt <= now) dedup.delete(entryKey);
  }
  return dedup.has(key);
}

function rememberTelegramNewSessionMessage(message: unknown): void {
  const key = getTelegramNewSessionMessageKey(message);
  if (key !== undefined) {
    getTelegramNewSessionDedup().set(
      key,
      Date.now() + TELEGRAM_NEW_SESSION_DEDUP_TTL_MS,
    );
  }
}

`;

const original = `export async function handleTelegramNewSessionCommand<TMessage>(
  message: TMessage,
  deps: TelegramNewSessionCommandDeps<TMessage>,
): Promise<void> {
  const blockingReason = getTelegramNewSessionBlockingReason({`;
const replacement = `export async function handleTelegramNewSessionCommand<TMessage>(
  message: TMessage,
  deps: TelegramNewSessionCommandDeps<TMessage>,
): Promise<void> {
  if (isDuplicateTelegramNewSessionMessage(message)) return;
  const blockingReason = getTelegramNewSessionBlockingReason({`;
const notice = `  await deps.sendTextReply("🆕 Starting a new session in this thread.");
}`;
const noticeReplacement = `  rememberTelegramNewSessionMessage(message);
  await deps.sendTextReply("🆕 Starting a new session in this thread.");
}`;

const manifest = await readFile(join(packageRoot, "package.json"), "utf8");
if (!/^\s*"version":\s*"0\.20\.6",?\s*$/m.test(manifest)) {
  throw new Error(
    "Refusing to patch @llblab/pi-telegram; expected version 0.20.6.",
  );
}

let source = await readFile(commandsPath, "utf8");
if (!source.includes(marker)) {
  if (!source.includes(original) || !source.includes(notice)) {
    throw new Error(
      `Telegram /new dedup patch no longer applies cleanly to ${commandsPath}.`,
    );
  }
  source = source
    .replace(
      "const TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY =",
      helpers + "const TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY =",
    )
    .replace(original, replacement)
    .replace(notice, noticeReplacement);
  await writeFile(commandsPath, source);
}
