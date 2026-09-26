// Raw update handlers precede Telegram authorization. Arm only from an already
// authorized section callback; accept an exact private actor/chat/message reply.
export class PlacesReply {
  private pending: { chatId: number; afterMessageId: number; promptText: string; expiresAt: number; receive: (text: string) => Promise<void> } | undefined;
  constructor(private readonly now = Date.now) {}
  clear(): void { this.pending = undefined; }
  arm(ctx: { chatId: number; messageId?: number }, receive: (text: string) => Promise<void>, promptText: string): void {
    if (!Number.isSafeInteger(ctx.chatId) || ctx.chatId <= 0 || !Number.isSafeInteger(ctx.messageId) || (ctx.messageId ?? 0) <= 0) {
      throw new Error("Open /place_rankings in your private chat to enter text.");
    }
    this.pending = { chatId: ctx.chatId, afterMessageId: ctx.messageId!, promptText, expiresAt: this.now() + 10 * 60_000, receive };
  }
  async handle(update: unknown): Promise<"pass" | "consume"> {
    const pending = this.pending;
    if (!pending) return "pass";
    if (pending.expiresAt <= this.now()) { this.clear(); return "pass"; }
    const message = object(object(update)?.message);
    const reply = object(message?.reply_to_message);
    if (!message || object(message.chat)?.type !== "private" || object(message.chat)?.id !== pending.chatId ||
        object(message.from)?.id !== pending.chatId || reply?.text !== pending.promptText || object(reply?.from)?.is_bot !== true ||
        typeof reply.message_id !== "number" || !Number.isSafeInteger(reply.message_id) || reply.message_id <= pending.afterMessageId ||
        typeof message.text !== "string") return "pass";
    this.clear(); // claim before awaiting: duplicate deliveries cannot mutate twice
    try { await pending.receive(message.text); }
    catch { /* Claimed input must not fall through to Pi after a possible save. */ }
    return "consume";
  }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
