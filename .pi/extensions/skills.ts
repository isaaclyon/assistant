import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

const MAX_DESC = 80;

/** Truncate a description to MAX_DESC chars, appending an ellipsis when cut. */
export function truncate(desc: string, max = MAX_DESC): string {
  const trimmed = desc.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * `/skills` — list available skills with a truncated description of each.
 * Menu-visible so it appears in Telegram's `/` autocomplete; the handler closes
 * over `pi` to read the current skill list at call time.
 */
export default function skillsExtension(pi: ExtensionAPI): void {
  registerReloadSafeTelegramCommand({
    name: "skills",
    description: "List available skills with a short description of each",
    showInMenu: true,
    emoji: "📚",
    handler: async (ctx) => {
      const skills = pi.getCommands().filter((c) => c.source === "skill");
      if (skills.length === 0) {
        await ctx.reply("No skills available.");
        return;
      }
      const lines = skills
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => `/${s.name} — ${s.description ? truncate(s.description) : "(no description)"}`);
      await ctx.reply(lines.join("\n"));
    },
  });
}
