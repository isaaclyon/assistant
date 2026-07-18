import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(
  root,
  "node_modules",
  "@howaboua",
  "pi-codex-conversion",
);

async function assertPinnedVersion() {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (manifest.version !== "2.2.13") {
    throw new Error(
      `Refusing to patch @howaboua/pi-codex-conversion ${String(manifest.version)}; expected 2.2.13.`,
    );
  }
}

async function patchFile(path, original, replacement) {
  const source = await readFile(path, "utf8");
  if (source.includes(replacement)) return;
  if (!source.includes(original)) {
    throw new Error(`Codex config-path patch no longer applies cleanly to ${path}.`);
  }
  await writeFile(path, source.replace(original, replacement));
}

await assertPinnedVersion();
await patchFile(
  join(packageRoot, "dist", "adapter", "activation", "config.js"),
  `export function getCodexConversionConfigPath(agentDir = getAgentDir()) {
    return join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
}`,
  `export function getCodexConversionConfigPath(agentDir = getAgentDir()) {
    return process.env["PI_CODEX_CONVERSION_CONFIG_PATH"]?.trim()
        || join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
}`,
);
await patchFile(
  join(packageRoot, "src", "adapter", "activation", "config.ts"),
  `export function getCodexConversionConfigPath(agentDir: string = getAgentDir()): string {
\treturn join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
}`,
  `export function getCodexConversionConfigPath(agentDir: string = getAgentDir()): string {
\treturn process.env["PI_CODEX_CONVERSION_CONFIG_PATH"]?.trim()
\t\t|| join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
}`,
);
