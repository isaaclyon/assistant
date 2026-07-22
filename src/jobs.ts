import { Cron } from "croner";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  createHeartbeatRunner,
  parseHeartbeatFields,
  runCompiledHeartbeatChecker,
  type StatefulHeartbeatDefinition,
} from "./heartbeat.js";
import { type WebhookServer, startWebhookServer } from "./webhook.js";

export interface JobsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface PromptJobBase {
  id: string;
  prompt: string;
  target?: string;
}

export interface CronJob extends PromptJobBase {
  type: "cron";
  schedule: string;
  tz?: string;
}

export interface AtJob extends PromptJobBase {
  type: "at";
  at: string;
}

export interface HeartbeatJob extends StatefulHeartbeatDefinition {
  type: "heartbeat";
  schedule: string;
  tz?: string;
  target?: string;
}

export interface WebhookJob extends PromptJobBase {
  type: "webhook";
  hmacSecret?: string;
}

export type JobDefinition = CronJob | AtJob | HeartbeatJob | WebhookJob;

interface JobsState {
  fired: Record<string, number>;
  lastRun: Record<string, number>;
  lastLoadError: string | null;
}

const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_PROMPT_BYTES = 8 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeCron(schedule: string, tz: string | undefined): Cron {
  return new Cron(schedule, tz === undefined ? {} : { timezone: tz });
}

export interface ParseJobsFileOptions {
  validTargets?: ReadonlySet<string>;
  requireTargets?: boolean;
  compatibilityTarget?: string;
}

export function parseJobsFile(
  raw: string,
  options: ParseJobsFileOptions = {},
): JobDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`jobs.json is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error("jobs.json must be a JSON object");
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
    throw new Error('jobs.json must declare "version": 2 or 3');
  }
  if (!Array.isArray(parsed.jobs)) throw new Error('jobs.json must have a "jobs" array');
  if (parsed.version === 1) {
    const legacyHeartbeats = parsed.jobs.flatMap((entry: unknown, index: number) => {
      if (!isRecord(entry) || entry.type !== "heartbeat") return [];
      return [typeof entry.id === "string" && ID_PATTERN.test(entry.id) ? entry.id : `jobs[${index}]`];
    });
    if (legacyHeartbeats.length > 0) {
      throw new Error(
        `Legacy heartbeat jobs ${legacyHeartbeats.join(", ")} must be migrated to checker/rule/onTrigger before deployment`,
      );
    }
  }

  const errors: string[] = [];
  const jobs: JobDefinition[] = [];
  const seenIds = new Set<string>();
  parsed.jobs.forEach((entry: unknown, index: number) => {
    const label = `jobs[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    const id = entry.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      errors.push(`${label}: "id" must match ${ID_PATTERN}`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`${label}: duplicate id "${id}"`);
      return;
    }
    seenIds.add(id);
    const targetRequired = parsed.version === 3 || options.requireTargets === true;
    let target = entry.target;
    if (target === undefined && targetRequired) {
      target = options.compatibilityTarget;
      if (target === undefined) {
        errors.push(
          `${label} (${id}): "target" is required; migrate this job with target "isaac" or another configured instance`,
        );
        return;
      }
    }
    if (target !== undefined) {
      if (typeof target !== "string" || !ID_PATTERN.test(target)) {
        errors.push(`${label} (${id}): "target" must be a stable instance ID`);
        return;
      }
      if (target === "both-personal") {
        if (
          options.validTargets !== undefined &&
          (!options.validTargets.has("isaac") || !options.validTargets.has("emma"))
        ) {
          errors.push(
            `${label} (${id}): target "both-personal" requires configured targets isaac and emma`,
          );
          return;
        }
      } else if (
        options.validTargets !== undefined &&
        !options.validTargets.has(target)
      ) {
        errors.push(`${label} (${id}): unknown target "${target}"`);
        return;
      }
    }
    const targetField = target === undefined ? {} : { target };
    const requirePrompt = (): string | undefined => {
      const prompt = entry.prompt;
      if (
        typeof prompt !== "string" ||
        prompt.trim().length === 0 ||
        Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES
      ) {
        errors.push(`${label} (${id}): "prompt" must be a non-empty string of at most 8 KB`);
        return undefined;
      }
      return prompt;
    };

    const requireSchedule = (): string | undefined => {
      const schedule = entry.schedule;
      const tz = entry.tz;
      if (typeof schedule !== "string" || schedule.trim().length === 0) {
        errors.push(`${label} (${id}): "schedule" must be a cron expression`);
        return undefined;
      }
      if (tz !== undefined && (typeof tz !== "string" || tz.trim().length === 0)) {
        errors.push(`${label} (${id}): "tz" must be an IANA time zone string`);
        return undefined;
      }
      try {
        makeCron(schedule, tz as string | undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${label} (${id}): invalid schedule/tz: ${message}`);
        return undefined;
      }
      return schedule;
    };

    switch (entry.type) {
      case "cron": {
        const schedule = requireSchedule();
        const prompt = requirePrompt();
        if (schedule === undefined || prompt === undefined) return;
        jobs.push({
          id,
          type: "cron",
          schedule,
          prompt,
          ...targetField,
          ...(entry.tz === undefined ? {} : { tz: entry.tz as string }),
        });
        return;
      }
      case "at": {
        const prompt = requirePrompt();
        const at = entry.at;
        if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
          errors.push(`${label} (${id}): "at" must be a parseable timestamp (ISO 8601)`);
          return;
        }
        if (prompt === undefined) return;
        jobs.push({ id, type: "at", at, prompt, ...targetField });
        return;
      }
      case "heartbeat": {
        const schedule = requireSchedule();
        const fields = parseHeartbeatFields(entry, `${label} (${id})`, errors);
        if (schedule === undefined || fields === undefined) return;
        jobs.push({
          id,
          type: "heartbeat",
          schedule,
          ...fields,
          ...targetField,
          ...(entry.tz === undefined ? {} : { tz: entry.tz as string }),
        });
        return;
      }
      case "webhook": {
        const prompt = requirePrompt();
        const hmacSecret = entry.hmacSecret;
        if (
          hmacSecret !== undefined &&
          (typeof hmacSecret !== "string" || hmacSecret.trim().length === 0)
        ) {
          errors.push(`${label} (${id}): "hmacSecret" must be a non-empty string`);
          return;
        }
        if (prompt === undefined) return;
        jobs.push({
          id,
          type: "webhook",
          prompt,
          ...targetField,
          ...(hmacSecret === undefined ? {} : { hmacSecret }),
        });
        return;
      }
      default:
        errors.push(`${label} (${id}): "type" must be one of cron, at, heartbeat, webhook`);
    }
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
  return jobs;
}

async function loadState(path: string): Promise<JobsState> {
  const empty: JobsState = { fired: {}, lastRun: {}, lastLoadError: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  const numberMap = (value: unknown): Record<string, number> => {
    if (!isRecord(value)) return {};
    const result: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
    }
    return result;
  };
  return {
    fired: numberMap(parsed.fired),
    lastRun: numberMap(parsed.lastRun),
    lastLoadError: typeof parsed.lastLoadError === "string" ? parsed.lastLoadError : null,
  };
}

async function saveState(path: string, state: JobsState): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function ensureWebhookSecret(path: string): Promise<string> {
  try {
    await writeFile(path, `${randomBytes(32).toString("hex")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const rawSecret = await readFile(path, "utf8");
  const secret = rawSecret.trim();
  if (secret.length === 0) throw new Error(`Webhook secret file is empty: ${path}`);
  return secret;
}

export interface CheckResult {
  ok: boolean;
  stdout: string;
}

export interface JobSchedulerOptions {
  stateDir: string;
  webhookHost: string;
  webhookPort: number;
  inject: (prompt: string, dispatch?: JobDispatch) => Promise<void>;
  logger: JobsLogger;
  validTargets?: ReadonlySet<string>;
  requireTargets?: boolean;
  compatibilityTarget?: string;
  nowMs?: () => number;
  tickIntervalMs?: number;
  checkTimeoutMs?: number;
  runCheck?: (checkerId: string, timeoutMs: number) => Promise<CheckResult>;
}

export interface JobDispatch {
  jobId: string;
  target: string;
  eventId: string;
}

export interface JobScheduler {
  getJobs(): readonly JobDefinition[];
  reload(): Promise<void>;
  tick(): Promise<void>;
  webhookPort(): number | undefined;
  stop(): Promise<void>;
}

export async function startJobScheduler({
  stateDir,
  webhookHost,
  webhookPort,
  inject,
  logger,
  validTargets,
  requireTargets,
  compatibilityTarget,
  nowMs = Date.now,
  tickIntervalMs = 30_000,
  checkTimeoutMs = 60_000,
  runCheck = runCompiledHeartbeatChecker,
}: JobSchedulerOptions): Promise<JobScheduler> {
  const jobsPath = join(stateDir, "jobs.json");
  const statePath = join(stateDir, "jobs-state.json");
  const secretPath = join(stateDir, "webhook-secret");

  let jobs: JobDefinition[] = [];
  const nextRuns = new Map<string, number>();
  let state = await loadState(statePath);
  let webhookServer: WebhookServer | undefined;
  let stopped = false;
  const parseOptions: ParseJobsFileOptions = {
    ...(validTargets === undefined ? {} : { validTargets }),
    ...(requireTargets === undefined ? {} : { requireTargets }),
    ...(compatibilityTarget === undefined ? {} : { compatibilityTarget }),
  };
  const dispatchFor = (
    job: JobDefinition,
    eventId: string,
  ): JobDispatch | undefined =>
    job.target === undefined
      ? undefined
      : { jobId: job.id, target: job.target, eventId };
  const heartbeatRunner = createHeartbeatRunner({
    stateDir,
    runCheck,
    inject: (prompt, job) =>
      inject(
        prompt,
        dispatchFor(
          job as HeartbeatJob,
          `heartbeat:${job.id}:${createHash("sha256").update(prompt).digest("hex")}`,
        ),
      ),
    logger,
    nowMs,
    checkTimeoutMs,
  });

  const persistState = async (): Promise<void> => {
    try {
      await saveState(statePath, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Could not save jobs state: ${message}`);
    }
  };

  const recordLoadError = async (message: string): Promise<void> => {
    logger.error(`jobs.json rejected (keeping the last loaded jobs): ${message}`);
    if (state.lastLoadError !== message) {
      state = { ...state, lastLoadError: message };
      await persistState();
    }
  };

  const computeNextRun = (job: CronJob | HeartbeatJob, afterMs: number): void => {
    const next = makeCron(job.schedule, job.tz).nextRun(new Date(afterMs));
    if (next) nextRuns.set(job.id, next.getTime());
    else nextRuns.delete(job.id);
  };

  const syncWebhookServer = async (): Promise<void> => {
    const wantServer = jobs.some((job) => job.type === "webhook");
    if (wantServer && !webhookServer) {
      const secret = await ensureWebhookSecret(secretPath);
      webhookServer = await startWebhookServer({
        host: webhookHost,
        port: webhookPort,
        secret,
        getJob: (id) => {
          const job = jobs.find((entry) => entry.id === id);
          return job?.type === "webhook" ? job : undefined;
        },
        inject: (prompt, job) =>
          inject(prompt, dispatchFor(job, `webhook:${job.id}:${randomUUID()}`)),
        logger,
      });
      logger.info(`Webhook trigger server listening on ${webhookHost}:${webhookServer.port}.`);
    } else if (!wantServer && webhookServer) {
      const server = webhookServer;
      webhookServer = undefined;
      await server.close();
      logger.info("Webhook trigger server stopped (no webhook jobs).");
    }
  };

  let lastMtimeMs: number | undefined;
  const doReload = async (): Promise<void> => {
    lastMtimeMs = (await stat(jobsPath).catch(() => undefined))?.mtimeMs;
    let raw: string | undefined;
    try {
      raw = await readFile(jobsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await recordLoadError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    let loaded: JobDefinition[] = [];
    if (raw !== undefined) {
      try {
        loaded = parseJobsFile(raw, parseOptions);
      } catch (error) {
        await recordLoadError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    jobs = loaded;
    const ids = new Set(jobs.map((job) => job.id));
    const prune = (map: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.entries(map).filter(([key]) => ids.has(key)));
    state = {
      fired: prune(state.fired),
      lastRun: prune(state.lastRun),
      lastLoadError: null,
    };
    await persistState();
    await heartbeatRunner.prune(
      new Set(jobs.flatMap((job) => (job.type === "heartbeat" ? [job.id] : []))),
    );
    const now = nowMs();
    nextRuns.clear();
    for (const job of jobs) {
      if (job.type === "cron" || job.type === "heartbeat") computeNextRun(job, now);
    }
    await syncWebhookServer();
    logger.info(`Loaded ${jobs.length} job(s) from ${jobsPath}.`);
  };

  // Reloads and ticks share mutable job/state snapshots and must never overlap.
  let operationChain: Promise<void> = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = operationChain.then(operation, operation);
    operationChain = next.catch(() => {});
    return next;
  };
  const reload = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return enqueue(async () => {
      if (!stopped) await doReload();
    });
  };

  const heartbeatIsCurrent = async (job: HeartbeatJob): Promise<boolean> => {
    if (stopped) return false;
    let raw: string;
    try {
      raw = await readFile(jobsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Heartbeat '${job.id}' could not verify jobs.json: ${message}`);
      }
      return false;
    }
    let currentJobs: JobDefinition[];
    try {
      currentJobs = parseJobsFile(raw, parseOptions);
    } catch {
      // Invalid edits retain the last-good loaded jobs until corrected.
      return true;
    }
    const current = currentJobs.find((entry) => entry.id === job.id);
    return current?.type === "heartbeat" && isDeepStrictEqual(current, job);
  };

  const fireScheduled = async (
    job: CronJob | AtJob,
    eventId: string,
  ): Promise<boolean> => {
    let prompt: string;
    if (job.type === "at") {
      prompt = `One-time reminder '${job.id}' fired (scheduled for ${job.at}).\n\n${job.prompt}`;
    } else {
      prompt = `Scheduled job '${job.id}' fired (schedule: ${job.schedule}${job.tz ? ` ${job.tz}` : ""}).\n\n${job.prompt}`;
    }
    try {
      await inject(prompt, dispatchFor(job, eventId));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Job '${job.id}' prompt injection failed: ${message}`);
      return false;
    }
  };

  const doTick = async (): Promise<void> => {
    if (stopped) return;
    // ponytail: mtime poll backs up fs.watch; both funnel into reload().
    const mtimeMs = (await stat(jobsPath).catch(() => undefined))?.mtimeMs;
    if (mtimeMs !== lastMtimeMs) await doReload();
    for (const job of jobs) {
      if (stopped) return;
      const now = nowMs();
      if (job.type === "at") {
        if (state.fired[job.id] !== undefined || now < Date.parse(job.at)) continue;
        if (await fireScheduled(job, `at:${job.id}:${Date.parse(job.at)}`)) {
          state.fired[job.id] = now;
          state.lastRun[job.id] = now;
          await persistState();
        }
        continue;
      }
      if (job.type === "webhook") continue;
      const dueMs = nextRuns.get(job.id);
      if (dueMs === undefined || now < dueMs) continue;
      computeNextRun(job, now);
      if (job.type === "heartbeat") {
        await heartbeatRunner.run(job, () => heartbeatIsCurrent(job));
      } else {
        await fireScheduled(job, `cron:${job.id}:${dueMs}`);
      }
      state.lastRun[job.id] = now;
      await persistState();
    }
  };

  let tickPending = false;
  const tick = (): Promise<void> => {
    if (stopped || tickPending) return Promise.resolve();
    tickPending = true;
    return enqueue(async () => {
      try {
        await doTick();
      } finally {
        tickPending = false;
      }
    });
  };

  await reload();

  let watchTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(stateDir, (_event, filename) => {
      if (filename !== "jobs.json") return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        void reload().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`jobs.json reload failed: ${message}`);
        });
      }, 500);
      watchTimer.unref?.();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not watch ${stateDir} for job changes: ${message}`);
  }

  const interval = setInterval(() => {
    void tick().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Job scheduler tick failed: ${message}`);
    });
  }, tickIntervalMs);
  interval.unref?.();

  return {
    getJobs: () => jobs,
    reload,
    tick,
    webhookPort: () => webhookServer?.port,
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(watchTimer);
      watcher?.close();
      const server = webhookServer;
      webhookServer = undefined;
      await server?.close();
    },
  };
}
