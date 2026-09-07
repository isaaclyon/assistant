import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";
import { jobsContentHash, parseJobsFile } from "./jobs.js";
import { inspectUnresolvedJobHandoffs, recoverJobHandoff } from "./job-handoff.js";

export interface JobsCliEnvironment {
  PI_TELEGRAM_JOBS_DIR?: string;
  PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST?: string;
  PI_TELEGRAM_BRIDGE_STATE_ROOT?: string;
  PI_TELEGRAM_BRIDGE_STATE_DIR?: string;
  PI_TELEGRAM_BRIDGE_INSTANCE_ID?: string;
}
export interface ApplyJobsRequestOptions {
  stateDir?: string;
  env?: JobsCliEnvironment;
  now?: () => number;
  validateReload?: boolean;
  reloadTimeoutMs?: number;
}

const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
async function readJson(path: string, fallback?: unknown): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
function requireId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} must match ${ID_PATTERN}`);
  return value;
}
async function manifestInstances(env: JobsCliEnvironment): Promise<Array<Record<string, unknown>> | undefined> {
  if (!env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST) return undefined;
  const manifest = record(await readJson(env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST), "instance manifest");
  if (!Array.isArray(manifest.instances)) throw new Error("instance manifest has no instances array");
  return manifest.instances.map((entry: unknown) => record(entry, "instance"));
}
export async function resolveCoordinatorStateDir(env: JobsCliEnvironment = process.env): Promise<string> {
  if (env.PI_TELEGRAM_JOBS_DIR) return env.PI_TELEGRAM_JOBS_DIR;
  const stateRoot = env.PI_TELEGRAM_BRIDGE_STATE_ROOT || join(homedir(), ".local", "state", "pi-telegram-bridge");
  const instances = await manifestInstances(env);
  if (instances) {
    const coordinators = instances.filter((entry) => entry.jobsRole === "coordinator");
    if (coordinators.length !== 1) throw new Error(`Expected exactly one jobs coordinator; found ${coordinators.length}`);
    return join(stateRoot, "instances", requireId(coordinators[0]!.id, "coordinator ID"));
  }
  return env.PI_TELEGRAM_BRIDGE_STATE_DIR || stateRoot;
}
function relativeTimestamp(value: unknown, now: number): string {
  const match = typeof value === "string" ? /^(\d+)(s|m|h|d)$/.exec(value) : null;
  if (!match || Number(match[1]) < 1) throw new Error('"in" must be a positive duration such as 45m or 2h');
  const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(now + Number(match[1]) * units[match[2]!]!).toISOString();
}
async function publish(path: string, raw: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(raw, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

interface Publication {
  hash: string;
  status: "accepted" | "pending" | "rejected" | "superseded";
}
async function waitForReload(stateDir: string, hash: string, timeoutMs: number): Promise<Publication> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      if (jobsContentHash(await readFile(join(stateDir, "jobs.json"), "utf8")) !== hash) return { hash, status: "superseded" };
      const state = record(await readJson(join(stateDir, "jobs-state.json"), {}), "jobs state");
      if (state.observedHash === hash) {
        if (state.lastLoadError) return { hash, status: "rejected" };
        if (state.acceptedHash === hash) return { hash, status: "accepted" };
      }
    } catch {
      // A missing, old, or unreadable acknowledgement cannot undo a saved edit.
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return { hash, status: "pending" };
}

export async function applyJobsRequest(input: Record<string, unknown>, options: ApplyJobsRequestOptions = {}): Promise<Record<string, unknown>> {
  const request = record(input, "request");
  const env = options.env ?? process.env;
  if (request.operation === "inspect_handoffs" || request.operation === "recover_handoff") {
    const inspect = request.operation === "inspect_handoffs";
    const fields = new Set(inspect ? ["operation"] : ["operation", "dispatchId", "state", "revision", "action"]);
    if (Object.keys(request).some((key) => !fields.has(key))) throw new Error("Unknown recovery request field");
    // Unlike definitions, recovery is bound to the active recipient, never a
    // chat-selected target or the fleet coordinator's directory.
    const instanceId = env.PI_TELEGRAM_BRIDGE_INSTANCE_ID === undefined
      ? "local" : requireId(env.PI_TELEGRAM_BRIDGE_INSTANCE_ID, "instance ID");
    if (env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST && instanceId === "local") throw new Error("Recipient instance binding is required");
    const stateDir = options.stateDir ?? env.PI_TELEGRAM_BRIDGE_STATE_DIR ??
      (instanceId === "local" ? await resolveCoordinatorStateDir(env) : undefined);
    if (!stateDir) throw new Error("Recipient state directory is required");
    if (inspect) return { ok: true, operation: request.operation, ...(await inspectUnresolvedJobHandoffs({ stateDir, instanceId })) };
    if (typeof request.dispatchId !== "string" || typeof request.revision !== "string" ||
        (request.state !== "processing" && request.state !== "failed") ||
        (request.action !== "acknowledge" && request.action !== "retry")) {
      throw new Error("Invalid handoff recovery request");
    }
    await recoverJobHandoff({
      stateDir, instanceId, dispatchId: request.dispatchId, state: request.state,
      revision: request.revision, action: request.action,
    });
    return { ok: true, operation: request.operation, dispatchId: request.dispatchId,
      boundary: request.action === "retry" ? "pending" : "operator_acknowledged" };
  }
  const stateDir = options.stateDir || await resolveCoordinatorStateDir(env);
  const jobsPath = join(stateDir, "jobs.json");
  const statePath = join(stateDir, "jobs-state.json");
  const readExisting = async () => {
    const existing = record(await readJson(jobsPath, { version: 3, jobs: [] }), "jobs file");
    if (!Array.isArray(existing.jobs)) throw new Error("jobs file has no jobs array");
    return existing.jobs.map((job: unknown) => record(job, "job"));
  };
  if (request.operation === "list") return { ok: true, operation: "list", stateDir, jobs: await readExisting() };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const saved = await withMutationLock(join(stateDir, ".jobs-mutation-lock.sqlite"), async () => {
    const existingJobs = await readExisting();
    const state = record(await readJson(statePath, { fired: {} }), "jobs state");
    const fired = state.fired && typeof state.fired === "object" ? record(state.fired, "fired") : {};
    const pruned = existingJobs.filter((job) => job.type === "at" && typeof job.id === "string" && fired[job.id] !== undefined).map((job) => job.id);
    const jobs = existingJobs.filter((job) => !pruned.includes(job.id));
    let result: Record<string, unknown>;
    if (request.operation === "add_at") {
      const id = requireId(request.id);
      if ((request.at === undefined) === (request.in === undefined)) throw new Error('Provide exactly one of "at" or "in"');
      if (request.at !== undefined && typeof request.at !== "string") throw new Error('"at" must be a timestamp');
      const at = request.in === undefined ? new Date(request.at as string).toISOString() : relativeTimestamp(request.in, (options.now ?? Date.now)());
      const job = { id, type: "at", target: requireId(request.target, "target"), at, prompt: request.prompt };
      if (jobs.some((entry) => entry.id === id)) throw new Error(`Job already exists: ${id}`);
      jobs.push(job);
      result = { operation: "add_at", job, pruned };
    } else if (request.operation === "upsert") {
      const job = record(request.job, "job");
      const id = requireId(job.id, "job.id");
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) jobs.push(job); else jobs[index] = job;
      result = { operation: "upsert", job, created: index < 0, pruned };
    } else if (request.operation === "remove") {
      const id = requireId(request.id);
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`Unknown job: ${id}`);
      jobs.splice(index, 1);
      result = { operation: "remove", removed: id, pruned };
    } else throw new Error("operation must be list, add_at, upsert, or remove");
    // Include a new publication identity in the hashed bytes, even for a no-op
    // edit. A prior process/context's rejection cannot acknowledge this save.
    const raw = `${JSON.stringify({ version: 3, publicationId: randomUUID(), jobs }, null, 2)}\n`;
    const instances = await manifestInstances(env);
    parseJobsFile(raw, instances ? { validTargets: new Set(instances.map((entry) => requireId(entry.id))) } : {});
    await publish(jobsPath, raw);
    return { result, hash: jobsContentHash(raw) };
  });
  const publication = options.validateReload === false
    ? { hash: saved.hash, status: "pending" as const }
    : await waitForReload(stateDir, saved.hash, options.reloadTimeoutMs ?? 5_000);
  return { ok: true, ...saved.result, stateDir, publication };
}

export async function runJobsCli(): Promise<void> {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += String(chunk);
      if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("Request is too large");
    }
    process.stdout.write(`${JSON.stringify(await applyJobsRequest(JSON.parse(raw) as Record<string, unknown>))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Job mutation failed" })}\n`);
    process.exitCode = 1;
  }
}
