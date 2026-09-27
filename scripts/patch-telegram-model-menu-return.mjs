import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "node_modules", "@llblab", "pi-telegram");
const sourcePath = join(packageRoot, "lib", "menu-model.ts");

const original = `  deps.setCurrentModel(plan.selection.model);
  if (plan.selection.thinkingLevel) {
    deps.setThinkingLevel(plan.selection.thinkingLevel);
  }
  await deps.updateModelMenuMessage();`;
const replacement = `  deps.setCurrentModel(plan.selection.model);
  if (plan.selection.thinkingLevel) {
    deps.setThinkingLevel(plan.selection.thinkingLevel);
  }
  await deps.updateStatusMessage();`;

const manifest = await readFile(join(packageRoot, "package.json"), "utf8");
if (!/^\s*"version":\s*"0\.20\.6",?\s*$/m.test(manifest)) {
  throw new Error(
    "Refusing to patch @llblab/pi-telegram; expected version 0.20.6.",
  );
}

const source = await readFile(sourcePath, "utf8");
if (!source.includes(replacement)) {
  if (!source.includes(original)) {
    throw new Error(
      `Telegram model-menu return patch no longer applies cleanly to ${sourcePath}.`,
    );
  }
  await writeFile(sourcePath, source.replace(original, replacement));
}
