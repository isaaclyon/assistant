import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@llblab", "pi-telegram");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== "0.20.6") throw new Error("Unexpected Telegram version for debug patch");
const patches = [
  ["lib/commands.ts", "export interface TelegramExtensionCommandContext {", `export interface TelegramExtensionCommandContext {
  /** Authorized source destination, supplied by Telegram routing. */
  target?: { chatId: number; threadId?: number };`],
  ["lib/routing.ts", `        await extensionCommand.handler({
          name: command.name,`, `        await extensionCommand.handler({
          target: sourceTarget,
          name: command.name,`],
  ["index.ts", "  // --- Message Delivery ---", `  // Bridge-owned opt-in diagnostics use plain messages and the active destination.
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.debug-transport")] = {
    getActiveTarget: () => BridgeTarget.getOverrideTarget() ?? activeTurnRuntime.getTarget(),
    send: (target: { chatId: number; threadId?: number }, text: string) => sendMessage({
      chat_id: target.chatId,
      ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
      text,
    }),
  };
  // --- Message Delivery ---`],
];
for (const [file, original, replacement] of patches) {
  const path = join(root, file);
  const source = await readFile(path, "utf8");
  if (source.includes(replacement)) continue;
  if (source.split(original).length !== 2) throw new Error(`Telegram debug patch no longer applies cleanly: ${file}`);
  await writeFile(path, source.replace(original, replacement));
}
