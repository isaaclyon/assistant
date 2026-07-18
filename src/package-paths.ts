import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveTelegramExtensionPath(): string {
  return require.resolve("@llblab/pi-telegram");
}

export function resolveCodexExtensionPath(): string {
  return require.resolve("@howaboua/pi-codex-conversion/dist/index.js");
}
