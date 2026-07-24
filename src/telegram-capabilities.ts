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

export interface TelegramHostPromptPreparationResult {
  sessionReplaced: boolean;
}

export type TelegramHostPromptPreparation = (input: {
  trigger: "telegram";
}) => Promise<TelegramHostPromptPreparationResult>;

export type TelegramSessionReplacementTrigger =
  | "manual"
  | "telegram"
  | `job:${string}`;

type TelegramSessionReplacementGuard = (input: {
  trigger: TelegramSessionReplacementTrigger;
}) => string | undefined;

export interface TelegramHostHouseholdGroup {
  kind: "household-group";
  chatId: number;
  actors: readonly [
    { userId: number; label: "Isaac" },
    { userId: number; label: "Emma" },
  ];
}

interface HostRegistry extends Record<string, unknown> {
  version: 1;
  provider?: TelegramHostNewSession;
  token?: object;
  householdGroup?: TelegramHostHouseholdGroup;
  householdToken?: object;
  promptPreparation?: TelegramHostPromptPreparation;
  promptPreparationToken?: object;
  replacementGuard?: TelegramSessionReplacementGuard;
  replacementGuardToken?: object;
}

const HOST_REGISTRY_KEY = Symbol.for("pi-telegram.host-capability-registry");

function isHostRegistry(value: unknown): value is HostRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const provider = candidate.provider;
  const token = candidate.token;
  const householdGroup = candidate.householdGroup;
  const householdToken = candidate.householdToken;
  const promptPreparation = candidate.promptPreparation;
  const promptPreparationToken = candidate.promptPreparationToken;
  const replacementGuard = candidate.replacementGuard;
  const replacementGuardToken = candidate.replacementGuardToken;
  return (
    candidate.version === 1 &&
    (provider === undefined || typeof provider === "function") &&
    (token === undefined || (typeof token === "object" && token !== null)) &&
    (provider === undefined) === (token === undefined) &&
    (householdGroup === undefined ||
      (typeof householdGroup === "object" && householdGroup !== null)) &&
    (householdToken === undefined ||
      (typeof householdToken === "object" && householdToken !== null)) &&
    (householdGroup === undefined) === (householdToken === undefined) &&
    (promptPreparation === undefined || typeof promptPreparation === "function") &&
    (promptPreparationToken === undefined ||
      (typeof promptPreparationToken === "object" && promptPreparationToken !== null)) &&
    (promptPreparation === undefined) === (promptPreparationToken === undefined)
    && (replacementGuard === undefined || typeof replacementGuard === "function")
    && (replacementGuardToken === undefined ||
      (typeof replacementGuardToken === "object" && replacementGuardToken !== null))
    && (replacementGuard === undefined) === (replacementGuardToken === undefined)
  );
}

export function getTelegramSessionReplacementBlockingReason(
  trigger: TelegramSessionReplacementTrigger,
): string | undefined {
  const registry = (globalThis as Record<PropertyKey, unknown>)[HOST_REGISTRY_KEY];
  if (registry === undefined) return undefined;
  if (!isHostRegistry(registry)) {
    throw new Error(
      "Telegram host capability registry is occupied by an incompatible value.",
    );
  }
  return registry.replacementGuard?.({ trigger });
}

function bindHostCapability(
  field: "provider" | "householdGroup" | "promptPreparation",
  tokenField: "token" | "householdToken" | "promptPreparationToken",
  value: TelegramHostNewSession | TelegramHostHouseholdGroup | TelegramHostPromptPreparation,
  registeredError: string,
): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[HOST_REGISTRY_KEY];
  let registry: HostRegistry;
  if (existing === undefined) {
    registry = { version: 1 };
    store[HOST_REGISTRY_KEY] = registry;
  } else if (isHostRegistry(existing)) {
    registry = existing;
  } else {
    throw new Error(
      "Telegram host capability registry is occupied by an incompatible value.",
    );
  }
  if (registry[field]) throw new Error(registeredError);
  const token = {};
  (registry as Record<string, unknown>)[field] = value;
  (registry as Record<string, unknown>)[tokenField] = token;
  return () => {
    if (registry[tokenField] !== token) return;
    delete registry[field];
    delete registry[tokenField];
  };
}

export function bindTelegramHostNewSession(
  provider: TelegramHostNewSession,
): () => void {
  return bindHostCapability(
    "provider",
    "token",
    provider,
    "Telegram host newSession capability is already registered",
  );
}

export function bindTelegramHostHouseholdGroup(
  policy: TelegramHostHouseholdGroup,
): () => void {
  return bindHostCapability(
    "householdGroup",
    "householdToken",
    policy,
    "Telegram host household group capability is already registered",
  );
}

export function bindTelegramHostPromptPreparation(
  prepare: TelegramHostPromptPreparation,
): () => void {
  return bindHostCapability(
    "promptPreparation",
    "promptPreparationToken",
    prepare,
    "Telegram host prompt preparation capability is already registered",
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

/** Host-owned durable background-subagent service exposed to its repo-local tool. */
export function bindBridgeSubagents(service: object): () => void {
  return bindRegistry(
    Symbol.for("pi-telegram-bridge.subagent-registry"),
    "service",
    service,
    "Bridge subagent registry is occupied by an incompatible value.",
    "Bridge subagent service is already registered",
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
