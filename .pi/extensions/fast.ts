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
      await ctx.enqueuePrompt(`/codex fast ${action}`);
    },
  });
}
