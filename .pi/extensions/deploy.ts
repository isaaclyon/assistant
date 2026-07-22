import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

const DEPLOY_PROMPT_URL = new URL("../prompts/deploy.md", import.meta.url);

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

/** Expose the repo-owned GitHub finish-line prompt in Telegram's command menu. */
export default function deployExtension(_pi: ExtensionAPI): void {
  registerReloadSafeTelegramCommand({
    name: "deploy",
    description: "Publish changes to GitHub and drive the PR to green",
    showInMenu: true,
    emoji: "🚀",
    handler: async (ctx) => {
      const prompt = stripFrontmatter(await readFile(DEPLOY_PROMPT_URL, "utf8"));
      await ctx.enqueuePrompt(prompt);
    },
  });
}
