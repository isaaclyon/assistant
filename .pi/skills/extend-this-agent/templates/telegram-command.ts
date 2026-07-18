import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Path is relative to the destination, `.pi/extensions/<name>.ts`.
import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

/**
 * Scaffold for a Telegram-visible slash command. Copy to
 * `.pi/extensions/<name>.ts`, then rename the command and fill in the handler.
 *
 * registerReloadSafeTelegramCommand uses the fork's Telegram registry, so the
 * command is dispatched at the Telegram layer AND listed in the `/` autocomplete
 * menu (via showInMenu). It also handles reload-safe re-registration for you.
 * Do not use pi.registerCommand for a menu command — those never show in
 * autocomplete. Working example: `.pi/extensions/restart.ts`.
 */
export default function extend(_pi: ExtensionAPI): void {
  registerReloadSafeTelegramCommand({
    name: "example", // ^[a-z0-9_]{1,32}$, and not a reserved built-in name
    description: "What this command does.",
    showInMenu: true, // list it in Telegram's `/` autocomplete menu
    emoji: "✨", // required when showInMenu; keep it to a few characters
    handler: async (ctx) => {
      // ctx.args               — text typed after the command
      // ctx.reply(text)        — send a Telegram message immediately
      // ctx.enqueuePrompt(text)— hand text to Pi as a normal turn
      await ctx.reply("Done.");
    },
  });
}
