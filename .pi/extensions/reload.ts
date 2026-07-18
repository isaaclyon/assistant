import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

/** Expose Pi's built-in /reload command in Telegram's native command menu. */
export default function reloadExtension(_pi: ExtensionAPI): void {
  registerReloadSafeTelegramCommand({
    name: "reload",
    description: "Hot-reload skills and extensions without restarting",
    showInMenu: true,
    emoji: "♻️",
    handler: async (ctx) => {
      await ctx.enqueuePrompt("/reload");
    },
  });
}
