import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@llblab", "pi-telegram");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== "0.20.6") throw new Error("Unexpected Telegram version for silent veto patch");
const path = join(root, "lib", "queue.ts");
const original = "    if (proactiveEnabled && finalText && !assistant.errorMessage) {";
const replacement = `    // A proactive review may explicitly decline to notify. Human replies are unaffected.
    const silentVeto = rawFinalText?.trim() === "NO_REPLY";
    if (proactiveEnabled && finalText && !assistant.errorMessage && !silentVeto) {`;
const source = await readFile(path, "utf8");
if (!source.includes(replacement)) {
  if (source.split(original).length !== 2) throw new Error("Telegram silent veto patch no longer applies cleanly");
  await writeFile(path, source.replace(original, replacement));
}
