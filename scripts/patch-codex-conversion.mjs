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
    throw new Error(`Codex compatibility patch no longer applies cleanly to ${path}.`);
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

// Pi 0.87 carries instructions and tool declarations in system messages. The
// pinned adapter still consumes the legacy Context fields, including during
// prewarm. Use Pi's own delta replay so removed tools/sections stay removed.
await patchFile(
  join(packageRoot, "dist", "providers", "openai-codex", "request-body.js"),
  `import { clampThinkingLevel } from "@earendil-works/pi-ai";`,
  `import { clampThinkingLevel, normalizeContext, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";`,
);
await patchFile(
  join(packageRoot, "dist", "providers", "openai-codex", "request-body.js"),
  `export function buildRequestBody(model, context, options) {
    const supportsToolSearch`,
  `export function buildRequestBody(model, context, options) {
    const transcript = normalizeContext(context);
    context = {
        systemPrompt: getCurrentSystemPrompt(transcript.messages),
        tools: getCurrentTools(transcript.messages),
        messages: transcript.messages.filter((message) => message.role !== "system"),
    };
    const supportsToolSearch`,
);
