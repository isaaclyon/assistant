import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@llblab", "pi-telegram");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.version !== "0.20.6") throw new Error("Unexpected Telegram version for thinking-level patch");
const path = join(root, "lib", "model.ts");
let source = await readFile(path, "utf8");
for (const [original, replacement] of [
  ['  | "high"\n  | "xhigh";', '  | "high"\n  | "xhigh"\n  | "max";'],
  ['  "high",\n  "xhigh",\n];', '  "high",\n  "xhigh",\n  "max",\n];'],
]) {
  if (source.includes(replacement)) continue;
  if (source.split(original).length !== 2) throw new Error("Telegram thinking-level patch source changed");
  source = source.replace(original, replacement);
}
await writeFile(path, source);
