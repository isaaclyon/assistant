/** Conversation text extraction shared by Jev conversation routing and memory recall. */

export const CONVERSATION_TEXT_LIMIT = 4096;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function visibleText(content: unknown, limit = CONVERSATION_TEXT_LIMIT): string {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("\n") : "";
  // Pi/Telegram metadata includes local paths and handler output. Keep only the
  // conversational text; never include images, reasoning, tools, or summaries.
  return text.split(/(?:^|\n)\[(?:attachments|outputs|voice|time)(?:\||\])/)[0]!
    .trim().slice(0, limit);
}

/** Host jobs and subagent completions also use Pi's user role; only the fork writes this prefix. */
export function isTelegramText(text: string): boolean {
  return /^\[telegram(?:\||\])/.test(text);
}

/** Removes the fork's `[telegram|...]` origin header, leaving the human-written text. */
export function stripTelegramHeader(text: string): string {
  return text.replace(/^\[telegram(?:\|[^\]\n]*)?\]\s*/, "").trim();
}
