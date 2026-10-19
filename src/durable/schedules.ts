import { isAbsolute } from "node:path";

import {
  type HeartbeatCheckerArgs,
  type JsonObject,
  runCompiledHeartbeatChecker,
} from "../heartbeat.js";
import type { CheckResult, JobDefinition } from "../jobs.js";
import { createTypeSafeJudge, type SemanticJudge, TYPESAFE_API_KEY_FILE_ENV } from "../semantic-judge.js";
import type { NativeGoogleConfig } from "./config.js";

export interface NativeScheduleConfig {
  checkerIds: string[];
  judgeKeyFile?: string;
  webhook?: { port: number };
}

/** Compiled checkers that a profile may select. Task data never adds to this set. */
export const SUPPORTED_NATIVE_CHECKER_IDS = [
  "web-page-items",
  "retail-product-price",
  "gmail-inbox",
  "ynab-unapproved",
] as const;

export type NativeRunCheck = (
  checkerId: string,
  timeoutMs: number,
  args?: HeartbeatCheckerArgs,
  cursor?: JsonObject | null,
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<CheckResult>;

/** Seams for isolated tests. Production passes none. */
export interface NativeScheduleTestOptions {
  runCheck?: NativeRunCheck;
  judge?: SemanticJudge;
  /** Only honoured here so tests can bind an ephemeral port (0). */
  webhookPort?: number;
}

export interface NativeScheduleRuntime {
  allowedTypes: ReadonlySet<JobDefinition["type"]>;
  allowedCheckerIds: ReadonlySet<string>;
  runCheck: (
    checkerId: string,
    timeoutMs: number,
    args?: HeartbeatCheckerArgs,
    cursor?: JsonObject | null,
  ) => Promise<CheckResult>;
  judge: SemanticJudge;
  webhookPort: number;
}

const ORDINARY_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ", "TMPDIR", "TMP", "TEMP"]);
const MAX_PATH_LENGTH = 4096;

function ordinaryKey(key: string): boolean {
  return ORDINARY_KEYS.has(key) || key.startsWith("LC_");
}

function absoluteValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH ||
      /[\0\r\n]/.test(value) || !isAbsolute(value)) {
    throw new Error(`Native schedules require ${label} to be an absolute path`);
  }
  return value;
}

export function validateScheduleConfig(
  config: NativeScheduleConfig,
  testOptions: NativeScheduleTestOptions = {},
): void {
  const ids = config?.checkerIds;
  if (!Array.isArray(ids) || ids.length > SUPPORTED_NATIVE_CHECKER_IDS.length) {
    throw new Error("Native schedules require a bounded checkerIds list");
  }
  const supported: ReadonlySet<string> = new Set(SUPPORTED_NATIVE_CHECKER_IDS);
  for (const id of ids) {
    if (typeof id !== "string" || !supported.has(id)) throw new Error("Native schedules selected an unsupported checker");
  }
  if (new Set(ids).size !== ids.length) throw new Error("Native schedules checkerIds must be unique");
  if (config.judgeKeyFile !== undefined) absoluteValue(config.judgeKeyFile, "judgeKeyFile");
  if (config.webhook !== undefined) {
    const port = config.webhook.port;
    if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("Native schedules require an explicit webhook port from 1 to 65535");
    }
  }
  const override = testOptions.webhookPort;
  if (override !== undefined && (!Number.isSafeInteger(override) || override < 0 || override > 65535)) {
    throw new Error("Invalid webhook port override");
  }
}

/**
 * Builds the environment for one checker process: ordinary variables only,
 * with no ambient credentials or PI_* settings. Gmail alone receives the
 * selected Google runtime, plus the coordinator-owned state directory.
 */
export function sanitizedCheckerEnvironment(input: {
  checkerId: string;
  source?: NodeJS.ProcessEnv;
  google?: NativeGoogleConfig;
  coordinatorStateDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.source ?? process.env)) {
    if (value !== undefined && ordinaryKey(key)) env[key] = value;
  }
  if (input.checkerId === "gmail-inbox") {
    const gog = input.google?.gog;
    if (gog === undefined) throw new Error("The gmail-inbox checker requires configured Google gog access");
    env.PI_TELEGRAM_GOG_BINARY = gog.binary;
    env.PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE = gog.passwordFile;
    env.PI_TELEGRAM_GOG_HOME = gog.home;
    if (input.google?.account !== undefined) env.PI_TELEGRAM_GOOGLE_ACCOUNT = input.google.account;
    env.PI_TELEGRAM_BRIDGE_STATE_DIR = input.coordinatorStateDir;
  }
  return env;
}

export function buildScheduleRuntime(input: {
  schedules: NativeScheduleConfig;
  google?: NativeGoogleConfig;
  coordinatorStateDir: string;
  test?: NativeScheduleTestOptions;
  source?: NodeJS.ProcessEnv;
}): NativeScheduleRuntime {
  const { schedules, google, coordinatorStateDir } = input;
  const test = input.test ?? {};
  validateScheduleConfig(schedules, test);
  if (schedules.checkerIds.includes("gmail-inbox") && google?.gog === undefined) {
    throw new Error("The gmail-inbox checker requires configured Google gog access");
  }
  const allowedTypes = new Set<JobDefinition["type"]>(["cron", "at"]);
  if (schedules.checkerIds.length > 0) allowedTypes.add("heartbeat");
  if (schedules.webhook !== undefined) allowedTypes.add("webhook");
  const allowedCheckerIds: ReadonlySet<string> = new Set(schedules.checkerIds);
  const runner: NativeRunCheck = test.runCheck ?? (async (id, timeoutMs, args, cursor, options) =>
    runCompiledHeartbeatChecker(id, timeoutMs, args, cursor, options));
  return {
    allowedTypes,
    allowedCheckerIds,
    runCheck: async (checkerId, timeoutMs, args, cursor) => {
      if (!allowedCheckerIds.has(checkerId)) throw new Error("Checker is not selected for this coordinator");
      const env = sanitizedCheckerEnvironment({
        checkerId,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(google === undefined ? {} : { google }),
        coordinatorStateDir,
      });
      return runner(checkerId, timeoutMs, args, cursor, { env });
    },
    judge: test.judge ?? createTypeSafeJudge({
      env: schedules.judgeKeyFile === undefined ? {} : { [TYPESAFE_API_KEY_FILE_ENV]: schedules.judgeKeyFile },
    }),
    webhookPort: test.webhookPort ?? schedules.webhook?.port ?? 0,
  };
}
