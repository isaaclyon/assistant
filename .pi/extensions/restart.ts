import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

/**
 * Repo-local /restart Telegram command. Restarts the whole bridge process so it
 * comes back on the currently deployed release. Distinct from Pi's built-in
 * /reload, which hot-reloads skills/extensions in-process without restarting.
 *
 * The host publishes the restart trigger on a shared global symbol (see
 * src/telegram-capabilities.ts bindBridgeRestart). This extension is loaded as
 * TypeScript by Pi, separate from the host's compiled module graph, so it reads
 * the trigger through globalThis rather than importing host source.
 */
const RESTART_REGISTRY = Symbol.for("pi-telegram-bridge.restart-registry");

function getBridgeRestart(): (() => void) | undefined {
  const registry = (globalThis as Record<PropertyKey, unknown>)[RESTART_REGISTRY];
  const request =
    registry && typeof registry === "object"
      ? (registry as { request?: unknown }).request
      : undefined;
  return typeof request === "function" ? (request as () => void) : undefined;
}

export default function extend(_pi: ExtensionAPI): void {
  registerReloadSafeTelegramCommand({
    name: "restart",
    description: "Restart the bridge process (picks up the deployed release).",
    showInMenu: true,
    emoji: "🔄",
    handler: async (ctx) => {
      const restart = getBridgeRestart();
      if (!restart) {
        await ctx.reply("Restart unavailable: bridge restart capability is not bound.");
        return;
      }
      // Reply before triggering the restart so the acknowledgement is sent
      // before the process tears down its Telegram polling.
      await ctx.reply("Restarting the bridge… it will reconnect in a few seconds.");
      restart();
    },
  });
}
