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
  if (manifest.version !== "3.0.39") {
    throw new Error(
      `Refusing to patch @howaboua/pi-codex-conversion ${String(manifest.version)}; expected 3.0.39.`,
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
// Backport the model support from upstream 3.0.40 without its unrelated
// context-management changes or a Pi runtime upgrade.
await patchFile(
  join(packageRoot, "dist/providers/openai-codex/responses-lite-model.js"),
  String.raw`/^gpt-6-(?:astra|sol|luna)$/i`,
  String.raw`/^(?:gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol)$/i`,
);
await patchFile(
  join(packageRoot, "dist/providers/openai-codex/model-catalog.js"),
  `const SUPPLEMENTAL_MODELS = [`,
  `const SUPPLEMENTAL_MODELS = [
    {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: DEFAULT_CODEX_BASE_URL,
        reasoning: true,
        input: ["text", "image"],
        cost: {
            input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
            tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
        },
        contextWindow: 272_000,
        maxTokens: 128_000,
        thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
        compat: { supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: true },
    },`,
);
await patchFile(
  join(packageRoot, "dist/providers/openai-codex/model-catalog.js"),
  `        // Pi's built-ins can advertise "none", but the Codex catalog has no off effort here.`,
  `        if (model.id === "gpt-6.1-sol") {
            return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null, minimal: null } };
        }
        // Pi's built-ins can advertise "none", but the Codex catalog has no off effort here.`,
);
await patchFile(
  join(packageRoot, "dist", "adapter", "activation", "config-store.js"),
  `export function getCodexConversionConfigPath(agentDir = getAgentDir()) {
    return join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
}`,
  `export function getCodexConversionConfigPath(agentDir = getAgentDir()) {
    return process.env["PI_CODEX_CONVERSION_CONFIG_PATH"]?.trim()
        || join(agentDir, CODEX_CONVERSION_CONFIG_BASENAME);
}`,
);

// Reuse the adapter's own deferred settings application in RPC mode. The
// Host capability invokes the registered command with a fresh command context.
await patchFile(
  join(packageRoot, "dist", "ui", "settings", "command.js"),
  `            const arg = args.trim().toLowerCase();`,
  `            const arg = args.trim().toLowerCase();
            if (process.env["PI_CODEX_CONVERSION_CONFIG_PATH"]?.trim() &&
                (arg === "fast" || arg.startsWith("fast "))) {
                const action = arg.slice(4).trim() || "status";
                if (!["on", "off", "status"].includes(action)) {
                    ctx.ui.notify("Usage: /fast on|off|status", "warning");
                    return;
                }
                const path = getCodexConversionConfigPath();
                // Fail closed rather than letting upstream's forgiving reader
                // replace a malformed settings file with defaults.
                const { existsSync, readFileSync } = await import("node:fs");
                try {
                    if (existsSync(path)) {
                        const document = JSON.parse(readFileSync(path, "utf8"));
                        if (!document || typeof document !== "object" || Array.isArray(document))
                            throw new Error("Expected a settings object");
                    }
                } catch {
                    ctx.ui.notify("Fast mode unavailable: the assistant's Codex settings file is invalid.", "error");
                    return;
                }
                const saved = readCodexConversionConfig(path);
                if (action === "status") {
                    const effective = effectiveConfig(ctx).openai.fast;
                    ctx.ui.notify("Codex fast mode: " + (state.config.openai.fast ? "on" : "off") +
                        ". Saved for this assistant: " + (saved.openai.fast ? "on" : "off") +
                        (effective !== saved.openai.fast ? ". Overridden by project or environment settings." : ".") +
                        (pendingApplication ? " A change is pending until the current run settles." : ""), "info");
                    return;
                }
                const enabled = action === "on";
                const next = { ...saved, openai: { ...saved.openai, fast: enabled } };
                if (!saveAndApply(ctx, "global", next)) return;
                const effective = effectiveConfig(ctx).openai.fast;
                ctx.ui.notify("Codex fast mode saved: " + action + "." +
                    (effective !== enabled ? " Project or environment settings override this choice." :
                        pendingApplication ? " Applies when the current run settles." : " Applied.") +
                    (enabled ? " Priority processing where supported may use more quota or cost more." : ""), "info");
                return;
            }`,
);
