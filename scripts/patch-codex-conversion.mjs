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
// Telegram command only forwards validated arguments; it never reloads Pi.
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
