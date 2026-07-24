import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ConversationSessionTrigger = "telegram" | `job:${string}`;

export interface ConversationSessionPendingReplacement {
  kind: "automatic-telegram" | "automatic-job" | "manual";
  fromSessionId: string;
  humanPromptAt: string | null;
  requestedAt: string;
}

export interface ConversationSessionState {
  version: 1;
  lastHumanPromptAt: string | null;
  rotatedForHumanPromptAt: string | null;
  pendingReplacement?: ConversationSessionPendingReplacement;
}

export type ConversationSessionPreparationPlan =
  | { kind: "unchanged" }
  | { kind: "already-rotated" }
  | { kind: "persist"; state: ConversationSessionState }
  | {
      kind: "replace";
      pendingState: ConversationSessionState;
      successState: ConversationSessionState;
    };

interface PreparationInput {
  trigger: ConversationSessionTrigger;
  nowMs: number;
  timeoutMs: number;
  currentSessionId: string;
}

export interface SessionReplacementResult {
  cancelled: boolean;
  sessionId: string;
}

interface PolicyLogger {
  info(message: string): void;
  error(message: string): void;
}

interface ConversationSessionPolicyOptions {
  path: string;
  timeoutMs: number;
  nowMs?: () => number;
  instanceId?: string;
  logger?: PolicyLogger;
  saveState?: typeof saveConversationSessionState;
}

const STATE_KEYS = new Set([
  "version",
  "lastHumanPromptAt",
  "rotatedForHumanPromptAt",
  "pendingReplacement",
]);
const PENDING_KEYS = new Set([
  "kind",
  "fromSessionId",
  "humanPromptAt",
  "requestedAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown, field: string, nullable = true): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Conversation session state ${field} must be an ISO timestamp${nullable ? " or null" : ""}`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`Conversation session state ${field} must be a canonical ISO timestamp`);
  }
  return value;
}

export function parseConversationSessionState(raw: string): ConversationSessionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Conversation session state is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("Conversation session state must be an object");
  const unknown = Object.keys(parsed).find((key) => !STATE_KEYS.has(key));
  if (unknown) throw new Error(`Conversation session state has unknown field ${unknown}`);
  if (parsed.version !== 1) throw new Error("Conversation session state version must be 1");
  const state: ConversationSessionState = {
    version: 1,
    lastHumanPromptAt: canonicalTimestamp(parsed.lastHumanPromptAt, "lastHumanPromptAt"),
    rotatedForHumanPromptAt: canonicalTimestamp(
      parsed.rotatedForHumanPromptAt,
      "rotatedForHumanPromptAt",
    ),
  };
  if (parsed.pendingReplacement !== undefined) {
    if (!isRecord(parsed.pendingReplacement)) {
      throw new Error("Conversation session state pendingReplacement must be an object");
    }
    const pendingUnknown = Object.keys(parsed.pendingReplacement).find(
      (key) => !PENDING_KEYS.has(key),
    );
    if (pendingUnknown) {
      throw new Error(
        `Conversation session state pendingReplacement has unknown field ${pendingUnknown}`,
      );
    }
    const kind = parsed.pendingReplacement.kind;
    if (!(["automatic-telegram", "automatic-job", "manual"] as const).includes(kind as never)) {
      throw new Error("Conversation session state pendingReplacement.kind is invalid");
    }
    if (
      typeof parsed.pendingReplacement.fromSessionId !== "string" ||
      parsed.pendingReplacement.fromSessionId.length === 0
    ) {
      throw new Error("Conversation session state pendingReplacement.fromSessionId is invalid");
    }
    state.pendingReplacement = {
      kind: kind as ConversationSessionPendingReplacement["kind"],
      fromSessionId: parsed.pendingReplacement.fromSessionId,
      humanPromptAt: canonicalTimestamp(
        parsed.pendingReplacement.humanPromptAt,
        "pendingReplacement.humanPromptAt",
      ),
      requestedAt: canonicalTimestamp(
        parsed.pendingReplacement.requestedAt,
        "pendingReplacement.requestedAt",
        false,
      )!,
    };
  }
  return state;
}

export async function loadConversationSessionState(
  path: string,
): Promise<ConversationSessionState | undefined> {
  try {
    return parseConversationSessionState(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveConversationSessionState(
  path: string,
  state: ConversationSessionState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function withoutPending(state: ConversationSessionState): ConversationSessionState {
  const { pendingReplacement: _pending, ...rest } = state;
  return rest;
}

function recoveredState(
  state: ConversationSessionState,
  currentSessionId: string,
): ConversationSessionState {
  const pending = state.pendingReplacement;
  if (!pending) return state;
  if (pending.fromSessionId === currentSessionId) return withoutPending(state);
  if (pending.kind === "automatic-job") {
    return {
      ...withoutPending(state),
      rotatedForHumanPromptAt: pending.humanPromptAt,
    };
  }
  return {
    ...withoutPending(state),
    lastHumanPromptAt: pending.requestedAt,
    rotatedForHumanPromptAt: null,
  };
}

export function planConversationSessionPreparation(
  loadedState: ConversationSessionState | undefined,
  input: PreparationInput,
): ConversationSessionPreparationPlan {
  const now = new Date(input.nowMs).toISOString();
  if (!loadedState) {
    return input.trigger === "telegram"
      ? {
          kind: "persist",
          state: {
            version: 1,
            lastHumanPromptAt: now,
            rotatedForHumanPromptAt: null,
          },
        }
      : { kind: "unchanged" };
  }

  const state = recoveredState(loadedState, input.currentSessionId);
  const recovered = state !== loadedState;
  const lastHumanMs = state.lastHumanPromptAt
    ? Date.parse(state.lastHumanPromptAt)
    : undefined;

  if (lastHumanMs === undefined) {
    if (input.trigger !== "telegram") {
      return recovered ? { kind: "persist", state } : { kind: "unchanged" };
    }
    return {
      kind: "persist",
      state: { ...state, lastHumanPromptAt: now, rotatedForHumanPromptAt: null },
    };
  }

  if (input.trigger === "telegram" && input.nowMs - lastHumanMs < input.timeoutMs) {
    return {
      kind: "persist",
      state: { ...state, lastHumanPromptAt: now, rotatedForHumanPromptAt: null },
    };
  }

  if (state.rotatedForHumanPromptAt === state.lastHumanPromptAt) {
    if (input.trigger === "telegram") {
      return {
        kind: "persist",
        state: { ...state, lastHumanPromptAt: now, rotatedForHumanPromptAt: null },
      };
    }
    return recovered ? { kind: "persist", state } : { kind: "already-rotated" };
  }

  if (input.nowMs - lastHumanMs < input.timeoutMs) {
    return recovered ? { kind: "persist", state } : { kind: "unchanged" };
  }

  const pendingReplacement: ConversationSessionPendingReplacement = {
    kind: input.trigger === "telegram" ? "automatic-telegram" : "automatic-job",
    fromSessionId: input.currentSessionId,
    humanPromptAt: state.lastHumanPromptAt,
    requestedAt: now,
  };
  return {
    kind: "replace",
    pendingState: { ...state, pendingReplacement },
    successState:
      input.trigger === "telegram"
        ? {
            ...withoutPending(state),
            lastHumanPromptAt: now,
            rotatedForHumanPromptAt: null,
          }
        : {
            ...withoutPending(state),
            rotatedForHumanPromptAt: state.lastHumanPromptAt,
          },
  };
}

export class ConversationSessionPolicy {
  private operationChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: Required<Pick<ConversationSessionPolicyOptions, "path" | "timeoutMs" | "nowMs">> &
      Pick<ConversationSessionPolicyOptions, "instanceId" | "logger"> & {
        saveState: typeof saveConversationSessionState;
      },
    private state: ConversationSessionState | undefined,
  ) {}

  static async open(options: ConversationSessionPolicyOptions): Promise<ConversationSessionPolicy> {
    let state: ConversationSessionState | undefined;
    try {
      state = await loadConversationSessionState(options.path);
    } catch (error) {
      options.logger?.error(
        `Conversation session state load failed${options.instanceId ? ` for ${options.instanceId}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    return new ConversationSessionPolicy(
      {
        ...options,
        nowMs: options.nowMs ?? Date.now,
        saveState: options.saveState ?? saveConversationSessionState,
      },
      state,
    );
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async persist(state: ConversationSessionState): Promise<void> {
    try {
      await this.options.saveState(this.options.path, state);
      this.state = state;
    } catch (error) {
      this.options.logger?.error(
        `Conversation session state persist failed${this.options.instanceId ? ` for ${this.options.instanceId}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  prepare(
    trigger: ConversationSessionTrigger,
    currentSessionId: string,
    replace: () => Promise<SessionReplacementResult>,
  ): Promise<{ sessionReplaced: boolean }> {
    return this.exclusive(async () => {
      const plan = planConversationSessionPreparation(this.state, {
        trigger,
        nowMs: this.options.nowMs(),
        timeoutMs: this.options.timeoutMs,
        currentSessionId,
      });
      if (plan.kind === "unchanged") return { sessionReplaced: false };
      if (plan.kind === "already-rotated") {
        this.options.logger?.info(
          `Idle session rotation skipped (already rotated)${this.options.instanceId ? ` for ${this.options.instanceId}` : ""}.`,
        );
        return { sessionReplaced: false };
      }
      if (plan.kind === "persist") {
        await this.persist(plan.state);
        return { sessionReplaced: false };
      }

      await this.persist(plan.pendingState);
      let result: SessionReplacementResult;
      try {
        result = await replace();
      } catch (error) {
        await this.persist(withoutPending(plan.pendingState)).catch(() => undefined);
        throw error;
      }
      if (result.cancelled) {
        await this.persist(withoutPending(plan.pendingState));
        throw new Error("Automatic idle session replacement was cancelled");
      }
      await this.persist(plan.successState);
      this.options.logger?.info(
        `Idle session rotation performed${this.options.instanceId ? ` for ${this.options.instanceId}` : ""} (trigger: ${trigger}).`,
      );
      return { sessionReplaced: true };
    });
  }

  manualNew(
    currentSessionId: string,
    replace: () => Promise<SessionReplacementResult>,
  ): Promise<SessionReplacementResult> {
    return this.exclusive(async () => {
      const pending = this.state?.pendingReplacement;
      if (
        pending?.kind === "manual" &&
        pending.fromSessionId !== currentSessionId
      ) {
        await this.persist(recoveredState(this.state!, currentSessionId));
        return { cancelled: false, sessionId: currentSessionId };
      }
      const requestedAt = new Date(this.options.nowMs()).toISOString();
      const base: ConversationSessionState = this.state
        ? recoveredState(this.state, currentSessionId)
        : {
            version: 1,
            lastHumanPromptAt: null,
            rotatedForHumanPromptAt: null,
          };
      const pendingState: ConversationSessionState = {
        ...withoutPending(base),
        pendingReplacement: {
          kind: "manual",
          fromSessionId: currentSessionId,
          humanPromptAt: base.lastHumanPromptAt,
          requestedAt,
        },
      };
      await this.persist(pendingState);
      let result: SessionReplacementResult;
      try {
        result = await replace();
      } catch (error) {
        await this.persist(withoutPending(pendingState)).catch(() => undefined);
        throw error;
      }
      if (result.cancelled) {
        await this.persist(withoutPending(pendingState));
        return result;
      }
      await this.persist({
        version: 1,
        lastHumanPromptAt: requestedAt,
        rotatedForHumanPromptAt: null,
      });
      return result;
    });
  }
}
