import type { InboundInbox } from "./inbox.js";

// ADR-0002/0003: source-only pi-telegram is loaded by Pi, so the compiled host
// binds matching process-local protocols on shared symbols rather than
// importing TypeScript from node_modules (which Node cannot type-strip). Both
// registries share the shape { version: 1, <field>?, token? } where field and
// token are set together; the fork reads the field, the token guards unbind.

interface Registry extends Record<string, unknown> {
  token?: object;
}

function isRegistry(value: unknown, field: string): value is Registry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const bound = candidate[field];
  const token = candidate.token;
  return (
    candidate.version === 1 &&
    (bound === undefined ||
      (bound !== null && (typeof bound === "object" || typeof bound === "function"))) &&
    (token === undefined || (typeof token === "object" && token !== null)) &&
    (bound === undefined) === (token === undefined)
  );
}

/**
 * Publishes `value` under `field` on the shared registry at `key`. Returns a
 * token-guarded unbind so a later owner's teardown cannot clear a newer
 * binding. Throws if the field is already bound.
 */
function bindRegistry(
  key: symbol,
  field: string,
  value: object,
  occupiedError: string,
  registeredError: string,
): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[key];
  let registry: Registry;
  if (existing === undefined) {
    registry = { version: 1 };
    store[key] = registry;
  } else if (isRegistry(existing, field)) {
    registry = existing;
  } else {
    throw new Error(occupiedError);
  }
  if (registry[field]) throw new Error(registeredError);

  const token = {};
  registry[field] = value;
  registry.token = token;
  return () => {
    if (registry.token !== token) return;
    delete registry[field];
    delete registry.token;
  };
}

export interface TelegramHostNewSessionResult {
  cancelled: boolean;
}

export type TelegramHostNewSession = () => Promise<TelegramHostNewSessionResult>;

export function bindTelegramHostNewSession(
  provider: TelegramHostNewSession,
): () => void {
  return bindRegistry(
    Symbol.for("pi-telegram.host-capability-registry"),
    "provider",
    provider,
    "Telegram host capability registry is occupied by an incompatible value.",
    "Telegram host newSession capability is already registered",
  );
}

/**
 * Publishes a "restart the bridge process" trigger for the repo-local restart
 * extension to invoke. Unlike the fork capabilities above this one is consumed
 * inside this repo, but it uses the same global-symbol seam so the extension
 * (loaded as TypeScript by Pi, outside the host's compiled module graph) shares
 * the host's function reference through globalThis rather than an import.
 */
export function bindBridgeRestart(request: () => void): () => void {
  return bindRegistry(
    Symbol.for("pi-telegram-bridge.restart-registry"),
    "request",
    request,
    "Bridge restart registry is occupied by an incompatible value.",
    "Bridge restart capability is already registered",
  );
}

/** Marks this process as the always-on bridge runtime for repo-local hooks. */
export function bindBridgeRuntimeMarker(): () => void {
  return bindRegistry(
    Symbol.for("pi-telegram-bridge.runtime-registry"),
    "runtime",
    {},
    "Bridge runtime registry is occupied by an incompatible value.",
    "Bridge runtime marker is already registered",
  );
}

/**
 * The subset of the durable inbox handed across the ADR-0003 capability
 * boundary. The pinned pi-telegram fork records and reads turns but never owns
 * the database lifecycle, so `close` stays host-side.
 */
export type InboundInboxCapability = Pick<
  InboundInbox,
  "persist" | "remove" | "loadPending"
>;

export function bindTelegramInboundInbox(
  inbox: InboundInboxCapability,
): () => void {
  return bindRegistry(
    Symbol.for("pi-telegram.inbound-inbox-registry"),
    "inbox",
    inbox,
    "Telegram inbound inbox registry is occupied by an incompatible value.",
    "Telegram inbound inbox is already registered",
  );
}
