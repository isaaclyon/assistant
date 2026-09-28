import { isTelegramText, stripTelegramHeader, visibleText } from "./conversation-text.js";
import { DATE_TEXT_LIMIT, resolveDateContext, type DateContext } from "./date-context.js";

const REGISTRY_KEY = Symbol.for("pi-telegram-bridge.date-context-registry");
interface DateContextRegistry {
  version: 1;
  token: object;
  take(prompt: string): DateContext | undefined;
}

/** The host owns the timestamp; the extension consumes once at agent start.
 * Compare the human text so delayed jobs or a different turn cannot inherit it. */
export function createDateContextHandoff(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  let pending: { text: string; context: DateContext } | undefined;
  const body = (text: string) => visibleText(text.split(/(?:^|\n)\[(?:forward|reply)(?:\||\])/)[0]!, DATE_TEXT_LIMIT);
  return {
    prepare(prompt?: { text: string; sentAtMs?: number }): void {
      pending = undefined;
      // Legacy inbox rows without a sent time cannot safely anchor relative dates.
      if (!prompt || !Number.isSafeInteger(prompt.sentAtMs) || prompt.sentAtMs! <= 0) return;
      const text = body(prompt.text);
      const context = resolveDateContext(text, { sentAtMs: prompt.sentAtMs!, timeZone });
      if (context.ranges.length || context.unresolved.length) pending = { text, context };
    },
    take(prompt: string): DateContext | undefined {
      if (!isTelegramText(prompt)) return undefined;
      const prepared = pending;
      pending = undefined;
      if (!prepared || body(stripTelegramHeader(prompt)) !== prepared.text) return undefined;
      return prepared.context;
    },
  };
}

export function bindDateContextHandoff(handoff: Pick<ReturnType<typeof createDateContextHandoff>, "take">): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  if (store[REGISTRY_KEY] !== undefined) throw new Error("Date context handoff is already bound");
  const token = {};
  store[REGISTRY_KEY] = { version: 1, token, take: (prompt: string) => handoff.take(prompt) } satisfies DateContextRegistry;
  return () => {
    if ((store[REGISTRY_KEY] as DateContextRegistry | undefined)?.token === token) delete store[REGISTRY_KEY];
  };
}

export function takePreparedDateContext(prompt: string): DateContext | undefined {
  const registry = (globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY] as DateContextRegistry | undefined;
  return registry?.version === 1 ? registry.take(prompt) : undefined;
}
