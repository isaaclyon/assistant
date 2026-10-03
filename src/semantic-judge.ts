import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Pinned so tuned thresholds do not move when TypeSafe's `jev-latest` alias does. */
export const SEMANTIC_JUDGE_MODEL = "jev-1.13.0";
export const TYPESAFE_API_KEY_FILE_ENV = "PI_TELEGRAM_TYPESAFE_API_KEY_FILE";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_KEY_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const RETRYABLE_STATUSES = new Set([429, 529]);

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface SemanticJudgeRequest {
  state: Record<string, unknown>;
  questions: Record<string, NoulQuestion>;
}

export interface SemanticJudgeResult {
  /** Resolved model version reported by the service. */
  model: string;
  /** P(yes) for each requested question ID. */
  probabilities: Record<string, number>;
  /** Provider-reported input tokens; absent means unreported, not free. */
  inputTokens?: number;
}

export type SemanticJudge = (request: SemanticJudgeRequest) => Promise<SemanticJudgeResult>;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readApiKey(path: string): Promise<string> {
  const unavailable = new Error("TypeSafe API key file is unavailable or unsafe");
  if (!isAbsolute(path)) throw unavailable;
  let key: string;
  try {
    const metadata = await stat(path);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size < 1 ||
      metadata.size > MAX_KEY_BYTES ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw unavailable;
    }
    key = (await readFile(path, "utf8")).trim();
  } catch {
    throw unavailable;
  }
  if (!key || /\s/.test(key)) throw unavailable;
  return key;
}

export function parseJudgeResponse(
  body: unknown,
  questionIds: readonly string[],
): SemanticJudgeResult {
  if (!isRecord(body) || typeof body.model !== "string" || !isRecord(body.answers)) {
    throw new Error("TypeSafe returned an invalid response");
  }
  const probabilities: Record<string, number> = {};
  for (const id of questionIds) {
    const answer = body.answers[id];
    if (
      !isRecord(answer) ||
      answer.type !== "noul" ||
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      throw new Error("TypeSafe returned an invalid response");
    }
    probabilities[id] = answer.noul;
  }
  const inputTokens = isRecord(body.usage) ? body.usage.input_tokens : undefined;
  return { model: body.model, probabilities,
    ...(typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0
      ? { inputTokens } : {}),
  };
}

/**
 * Creates a Jev Noul judge. The API key is read just in time on every call from
 * the file named by PI_TELEGRAM_TYPESAFE_API_KEY_FILE, so missing configuration
 * surfaces as an operational failure only for jobs that use semantic rules.
 */
export function createTypeSafeJudge({
  env = process.env,
  fetcher = fetch,
  timeoutMs = 15_000,
  maxAttempts = 3,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  env?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): SemanticJudge {
  return async (request) => {
    const keyFile = env[TYPESAFE_API_KEY_FILE_ENV]?.trim();
    if (!keyFile) throw new Error(`${TYPESAFE_API_KEY_FILE_ENV} is not configured`);
    const apiKey = await readApiKey(keyFile);
    const body = JSON.stringify({
      model: SEMANTIC_JUDGE_MODEL,
      state: request.state,
      questions: request.questions,
    });
    const questionIds = Object.keys(request.questions);

    for (let attempt = 1; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await fetcher(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        response = undefined;
      }
      const retryable = response === undefined || RETRYABLE_STATUSES.has(response.status);
      if (retryable && attempt < maxAttempts) {
        await response?.body?.cancel().catch(() => undefined);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (response === undefined) throw new Error("TypeSafe request failed");
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`TypeSafe returned HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("TypeSafe response is too large");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("TypeSafe response is too large");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("TypeSafe returned an invalid response");
      }
      return parseJudgeResponse(parsed, questionIds);
    }
  };
}
