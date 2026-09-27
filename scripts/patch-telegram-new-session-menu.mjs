import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "node_modules", "@llblab", "pi-telegram");
const sourcePath = join(packageRoot, "index.ts");
const original = `      async sendTargetText(target, text) {
        await sendTextReply(target.chatId, undefined, text, { target });
      },`;
const replacement = `      async sendTargetText(target, text) {
        await sendTextReply(target.chatId, undefined, text, { target });
        if (text === "✅ New session started in this thread.") {
          const ctx = telegramSessionContextStore.get();
          if (ctx) await menuActions.sendStatusMessage(target.chatId, 0, ctx, target.threadId);
        }
      },`;
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (manifest.version !== "0.20.6") throw new Error("Unexpected Telegram version for new-session menu patch");
const source = await readFile(sourcePath, "utf8");
if (!source.includes(replacement)) {
  if (source.split(original).length !== 2) throw new Error("Telegram new-session menu patch no longer applies cleanly");
  await writeFile(sourcePath, source.replace(original, replacement));
}
