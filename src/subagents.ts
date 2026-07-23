import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_SUBAGENT_MODEL = "openai-codex/gpt-5.6-luna";
export const DEFAULT_SUBAGENT_THINKING = "high";
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_SUBAGENT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const SUBAGENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type SubagentThinking =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SubagentJobStatus =
  | "queued" | "running" | "succeeded" | "failed" | "cancelled"
  | "timed_out" | "interrupted";
export interface SubagentOrigin { chatId: number; threadId?: number }
export interface SubagentTaskInput {
  task: string;
  context?: string;
  model?: string;
  thinking?: SubagentThinking;
}
export interface SubagentJob {
  id: string;
  batchId: string;
  task: string;
  context?: string;
  model: string;
  thinking: SubagentThinking;
  status: SubagentJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  partialOutput?: string;
  output?: string;
  failureReason?: string;
  sessionDir?: string;
}
export interface SubagentBatch {
  id: string;
  createdAt: number;
  jobIds: string[];
  origin?: SubagentOrigin;
  completionState: "pending" | "injecting" | "injected" | "uncertain";
}
interface PersistedState { version: 1; batches: SubagentBatch[]; jobs: SubagentJob[] }
export interface SubagentRunResult { output: string }
export type SubagentJobRunner = (
  job: SubagentJob,
  signal: AbortSignal,
  onPartial: (output: string) => void,
) => Promise<SubagentRunResult>;
export interface SubagentCompletion {
  batchId: string;
  jobIds: string[];
  origin?: SubagentOrigin;
}
export interface StartSubagentServiceOptions {
  stateDir: string;
  runner: SubagentJobRunner;
  injectCompletion: (completion: SubagentCompletion) => Promise<void>;
  timeoutMs?: number;
  outputLimitBytes?: number;
  retentionMs?: number;
  now?: () => number;
}

function bounded(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end--;
  return value.slice(0, end);
}
function terminal(status: SubagentJobStatus): boolean {
  return !["queued", "running"].includes(status);
}
function reason(error: unknown): string {
  if (error instanceof Error && error.message) return bounded(error.message, 512);
  return "Subagent execution failed";
}

export interface SubagentService {
  launch(input: { tasks: SubagentTaskInput[]; model?: string; thinking?: SubagentThinking; origin?: SubagentOrigin }): Promise<{ batchId: string; jobIds: string[] }>;
  list(filter?: { status?: "active" | "terminal" }): Array<Omit<SubagentJob, "task" | "context" | "partialOutput" | "output" | "sessionDir">>;
  inspect(jobId: string): SubagentJob;
  collect(input: { batchId?: string; jobIds?: string[] }): { jobs: SubagentJob[] };
  cancel(input: { batchId?: string; jobId?: string }): Promise<void>;
  waitForIdle(): Promise<void>;
  stop(): Promise<void>;
}

export async function startSubagentService(options: StartSubagentServiceOptions): Promise<SubagentService> {
  const root = join(options.stateDir, "subagents");
  const statePath = join(root, "state.json");
  const sessionsRoot = join(root, "sessions");
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const outputLimit = options.outputLimitBytes ?? DEFAULT_SUBAGENT_OUTPUT_LIMIT_BYTES;
  const retention = options.retentionMs ?? SUBAGENT_RETENTION_MS;
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  let state: PersistedState = { version: 1, batches: [], jobs: [] };
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as PersistedState;
    if (parsed.version === 1 && Array.isArray(parsed.batches) && Array.isArray(parsed.jobs)) state = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const cutoff = now() - retention;
  const expiredJobs = state.jobs.filter((job) => {
    const batch = state.batches.find((candidate) => candidate.id === job.batchId);
    return batch !== undefined && batch.createdAt < cutoff && ["injected", "uncertain"].includes(batch.completionState) && terminal(job.status);
  });
  const retainedBatches = new Set(state.batches.filter((b) => b.createdAt >= cutoff || !["injected", "uncertain"].includes(b.completionState) || b.jobIds.some((id) => state.jobs.some((j) => j.id === id && !terminal(j.status)))).map((b) => b.id));
  state.batches = state.batches.filter((b) => retainedBatches.has(b.id));
  state.jobs = state.jobs.filter((j) => retainedBatches.has(j.batchId));
  await Promise.all(expiredJobs.map((job) => job.sessionDir ? rm(job.sessionDir, { recursive: true, force: true }) : Promise.resolve()));
  for (const job of state.jobs) {
    if (!terminal(job.status)) {
      job.status = "interrupted";
      job.finishedAt = now();
      job.durationMs = Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt));
      job.failureReason = "Bridge restarted before the child terminal result was observed";
    }
  }
  for (const batch of state.batches) {
    if (batch.completionState === "injecting") batch.completionState = "uncertain";
  }
  let persistChain = Promise.resolve();
  const persist = (): Promise<void> => {
    persistChain = persistChain.then(async () => {
      const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, statePath);
    });
    return persistChain;
  };
  await persist();
  const cleanupExpired = async (): Promise<void> => {
    const expiry = now() - retention;
    const expiredBatchIds = new Set(state.batches.filter((batch) =>
      batch.createdAt < expiry && ["injected", "uncertain"].includes(batch.completionState) && batch.jobIds.every((id) => {
        const job = state.jobs.find((candidate) => candidate.id === id);
        return job === undefined || terminal(job.status);
      }),
    ).map((batch) => batch.id));
    if (expiredBatchIds.size === 0) return;
    const removed = state.jobs.filter((job) => expiredBatchIds.has(job.batchId));
    state.batches = state.batches.filter((batch) => !expiredBatchIds.has(batch.id));
    state.jobs = state.jobs.filter((job) => !expiredBatchIds.has(job.batchId));
    await persist();
    await Promise.all(removed.map((job) => job.sessionDir ? rm(job.sessionDir, { recursive: true, force: true }) : Promise.resolve()));
  };
  const cleanupTimer = setInterval(() => { void cleanupExpired().catch(() => {}); }, 60 * 60 * 1_000);
  cleanupTimer.unref?.();
  const controllers = new Map<string, AbortController>();
  const running = new Map<string, Promise<void>>();
  const completions = new Set<Promise<void>>();
  let stopping = false;

  const maybeComplete = async (batch: SubagentBatch): Promise<void> => {
    if (batch.completionState !== "pending") return;
    if (!batch.jobIds.every((id) => terminal(state.jobs.find((j) => j.id === id)!.status))) return;
    batch.completionState = "injecting";
    await persist();
    try {
      await options.injectCompletion({ batchId: batch.id, jobIds: [...batch.jobIds], ...(batch.origin ? { origin: batch.origin } : {}) });
      batch.completionState = "injected";
      await persist();
    } catch (error) {
      batch.completionState = "pending";
      await persist();
      throw error;
    }
  };
  const scheduleCompletion = (batch: SubagentBatch): void => {
    const completion = maybeComplete(batch)
      .catch(() => {})
      .finally(() => completions.delete(completion));
    completions.add(completion);
  };
  const run = (job: SubagentJob): void => {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Subagent timed out"));
    }, timeoutMs);
    timer.unref?.();
    const promise = (async () => {
      job.status = "running";
      job.startedAt = now();
      await persist();
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = await options.runner(job, controller.signal, (partial) => {
          job.partialOutput = bounded(partial, outputLimit);
          void persist();
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        job.output = bounded(result.output, outputLimit);
        job.status = "succeeded";
      } catch (error) {
        job.failureReason = reason(error);
        job.status = timedOut ? "timed_out" : controller.signal.aborted ? "cancelled" : "failed";
      } finally {
        clearTimeout(timer);
        controllers.delete(job.id);
        job.finishedAt = now();
        job.durationMs = Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt));
        await persist();
        const batch = state.batches.find((candidate) => candidate.id === job.batchId)!;
        scheduleCompletion(batch);
      }
    })().finally(() => running.delete(job.id));
    running.set(job.id, promise);
  };

  // Interrupted batches that had not begun completion still deserve one recovery event.
  for (const batch of state.batches) {
    if (batch.completionState === "pending") scheduleCompletion(batch);
  }

  return {
    async launch(input) {
      if (stopping) throw new Error("Subagent service is stopping");
      if (input.tasks.length === 0) throw new Error("At least one task is required");
      const batchId = `batch-${randomUUID()}`;
      const batch: SubagentBatch = { id: batchId, createdAt: now(), jobIds: [], completionState: "pending", ...(input.origin ? { origin: input.origin } : {}) };
      const jobs = input.tasks.map((task): SubagentJob => {
        if (!task.task.trim()) throw new Error("Subagent tasks must not be blank");
        const id = `job-${randomUUID()}`;
        batch.jobIds.push(id);
        return {
          id, batchId, task: bounded(task.task, 16 * 1024),
          ...(task.context ? { context: bounded(task.context, 32 * 1024) } : {}),
          model: task.model ?? input.model ?? DEFAULT_SUBAGENT_MODEL,
          thinking: task.thinking ?? input.thinking ?? DEFAULT_SUBAGENT_THINKING,
          status: "queued", createdAt: now(), sessionDir: join(sessionsRoot, id),
        };
      });
      state.batches.push(batch);
      state.jobs.push(...jobs);
      await persist();
      for (const job of jobs) run(job);
      return { batchId, jobIds: [...batch.jobIds] };
    },
    list(filter = {}) {
      return state.jobs.filter((job) => filter.status === undefined || (filter.status === "active" ? !terminal(job.status) : terminal(job.status))).map((job) => {
        const { task: _task, context: _context, partialOutput: _partial, output: _output, sessionDir: _sessionDir, ...summary } = job;
        return summary;
      });
    },
    inspect(jobId) {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
      return { ...job };
    },
    collect(input) {
      const ids = input.batchId ? state.batches.find((batch) => batch.id === input.batchId)?.jobIds : input.jobIds;
      if (!ids) throw new Error("Unknown subagent batch or missing job IDs");
      return { jobs: ids.map((id) => {
        const job = state.jobs.find((candidate) => candidate.id === id);
        if (!job) throw new Error(`Unknown subagent job: ${id}`);
        return { ...job };
      }) };
    },
    async cancel(input) {
      const ids = input.batchId ? state.batches.find((batch) => batch.id === input.batchId)?.jobIds : input.jobId ? [input.jobId] : undefined;
      if (!ids) throw new Error("Unknown subagent batch/job");
      for (const id of ids) controllers.get(id)?.abort(new Error("Subagent cancelled"));
      await Promise.all(ids.map((id) => running.get(id)).filter((promise): promise is Promise<void> => promise !== undefined));
    },
    async waitForIdle() { await Promise.all([...running.values()]); await Promise.all([...completions]); await persistChain; },
    async stop() {
      stopping = true;
      clearInterval(cleanupTimer);
      for (const controller of controllers.values()) controller.abort(new Error("Bridge is shutting down"));
      await Promise.allSettled([...running.values()]);
      await Promise.allSettled([...completions]);
      await persistChain;
    },
  };
}
