import type { InboundInbox } from "./inbox.js";

/**
 * The subset of the durable inbox handed across the ADR-0003 capability
 * boundary. The pinned pi-telegram fork records and reads turns but never owns
 * the database lifecycle, so `close` stays host-side.
 */
export type InboundInboxCapability = Pick<
  InboundInbox,
  "persist" | "remove" | "loadPending"
>;

interface TelegramInboxRegistry {
  readonly version: 1;
  inbox?: InboundInboxCapability;
  token?: object;
}

// ADR-0002/0003: source-only pi-telegram is loaded by Pi, so the compiled host
// binds the matching process-local protocol on this shared symbol rather than
// importing TypeScript from node_modules (which Node cannot type-strip).
const TELEGRAM_INBOX_REGISTRY_KEY = Symbol.for(
  "pi-telegram.inbound-inbox-registry",
);

function isTelegramInboxRegistry(
  value: unknown,
): value is TelegramInboxRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const inbox = candidate.inbox;
  const token = candidate.token;
  if (candidate.version !== 1) return false;
  if (inbox !== undefined && typeof inbox !== "object") return false;
  if (token !== undefined && (!token || typeof token !== "object")) {
    return false;
  }
  return (inbox === undefined) === (token === undefined);
}

/**
 * Publishes the durable inbox on the shared registry the pinned fork reads.
 * Returns a token-guarded unbind so a later owner's teardown cannot clear a
 * newer inbox. Throws if an inbox is already bound.
 */
export function bindTelegramInboundInbox(
  inbox: InboundInboxCapability,
): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[TELEGRAM_INBOX_REGISTRY_KEY];
  let registry: TelegramInboxRegistry;
  if (existing === undefined) {
    registry = { version: 1 };
    store[TELEGRAM_INBOX_REGISTRY_KEY] = registry;
  } else if (isTelegramInboxRegistry(existing)) {
    registry = existing;
  } else {
    throw new Error(
      "Telegram inbound inbox registry is occupied by an incompatible value.",
    );
  }
  if (registry.inbox) {
    throw new Error("Telegram inbound inbox is already registered");
  }

  const token = {};
  registry.inbox = inbox;
  registry.token = token;
  return () => {
    if (registry.token !== token) return;
    delete registry.inbox;
    delete registry.token;
  };
}
