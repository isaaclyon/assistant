import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

export default function fastExtension(_pi: ExtensionAPI): void {
  registerReloadSafeTelegramCommand({
    name: "fast",
    description: "Codex priority processing: on, off, or status",
    showInMenu: true,
    emoji: "⚡",
    handler: async (ctx) => {
      const action = ctx.args.trim().toLowerCase() || "status";
      if (!["on", "off", "status"].includes(action)) {
        await ctx.reply("Usage: /fast on|off|status");
        return;
      }
      if (!process.env.PI_CODEX_CONVERSION_CONFIG_PATH?.trim()) {
        await ctx.reply("Fast mode unavailable outside the assistant runtime.");
        return;
      }
      const control = (globalThis as Record<PropertyKey, unknown>)[
        Symbol.for("pi-telegram-bridge.codex-fast")
      ] as ((action: string) => Promise<string>) | undefined;
      if (!control) {
        await ctx.reply("Codex fast-mode control is unavailable.");
        return;
      }
      try {
        await ctx.reply(await control(action));
      } catch {
        await ctx.reply("Could not change Codex fast mode. Check the assistant logs and try /fast status.");
      }
    },
  });
}
