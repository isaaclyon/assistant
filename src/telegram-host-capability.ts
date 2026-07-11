export interface TelegramHostNewSessionResult {
  cancelled: boolean;
}

export type TelegramHostNewSession = () => Promise<TelegramHostNewSessionResult>;

interface TelegramHostRegistry {
  readonly version: 1;
  provider?: TelegramHostNewSession;
  token?: object;
}

// ADR-0002: source-only pi-telegram is loaded by Pi, so the compiled host binds
// the matching process-local protocol without importing TypeScript from node_modules.
const TELEGRAM_HOST_REGISTRY_KEY = Symbol.for(
  "pi-telegram.host-capability-registry",
);

function isTelegramHostRegistry(value: unknown): value is TelegramHostRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const provider = candidate.provider;
  const token = candidate.token;
  return (
    candidate.version === 1 &&
    (provider === undefined || typeof provider === "function") &&
    (token === undefined || (typeof token === "object" && token !== null)) &&
    (provider === undefined) === (token === undefined)
  );
}

export function bindTelegramHostNewSession(
  provider: TelegramHostNewSession,
): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[TELEGRAM_HOST_REGISTRY_KEY];
  let registry: TelegramHostRegistry;
  if (existing === undefined) {
    registry = { version: 1 };
    store[TELEGRAM_HOST_REGISTRY_KEY] = registry;
  } else if (isTelegramHostRegistry(existing)) {
    registry = existing;
  } else {
    throw new Error(
      "Telegram host capability registry is occupied by an incompatible value.",
    );
  }
  if (registry.provider) {
    throw new Error("Telegram host newSession capability is already registered");
  }

  const token = {};
  registry.provider = provider;
  registry.token = token;
  return () => {
    if (registry.token !== token) return;
    delete registry.provider;
    delete registry.token;
  };
}
