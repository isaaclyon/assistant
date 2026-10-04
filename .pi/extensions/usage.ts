import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

export default function usageExtension(_pi: ExtensionAPI): void {
  registerReloadSafeTelegramCommand({
    name: "usage",
    description: "Active model allowance, percent remaining, and usage pace",
    showInMenu: true,
    emoji: "📊",
    handler: async (ctx) => {
      const read = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.usage")] as (() => Promise<string>) | undefined;
      if (!read) { await ctx.reply("Usage is unavailable outside the assistant runtime."); return; }
      try { await ctx.reply(await read()); }
      catch { await ctx.reply("Usage is unavailable right now. Try /usage again shortly."); }
    },
  });
}
