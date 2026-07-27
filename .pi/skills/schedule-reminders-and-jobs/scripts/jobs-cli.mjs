#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function resolveCoordinatorStateDir(env = process.env) {
  if (env.PI_TELEGRAM_JOBS_DIR) return env.PI_TELEGRAM_JOBS_DIR;
  const stateRoot = env.PI_TELEGRAM_BRIDGE_STATE_ROOT
    || join(homedir(), ".local", "state", "pi-telegram-bridge");
  if (env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST) {
    const manifest = record(
      await readJson(env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST),
      "instance manifest",
    );
    if (!Array.isArray(manifest.instances)) throw new Error("instance manifest has no instances array");
    const coordinators = manifest.instances.filter((entry) =>
      entry && typeof entry === "object" && entry.jobsRole === "coordinator");
    if (coordinators.length !== 1 || typeof coordinators[0].id !== "string") {
      throw new Error(`Expected exactly one jobs coordinator; found ${coordinators.length}`);
    }
    return join(stateRoot, "instances", coordinators[0].id);
  }
  return env.PI_TELEGRAM_BRIDGE_STATE_DIR || stateRoot;
}

function requireId(value, label = "id") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${ID_PATTERN}`);
  }
  return value;
}

function relativeTimestamp(value, now) {
  if (typeof value !== "string") throw new Error('"in" must be a duration such as 45m or 2h');
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error('"in" must be a positive duration such as 45m or 2h');
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(now + Number(match[1]) * units[match[2]]).toISOString();
}

function validateJobEnvelope(job) {
  record(job, "job");
  requireId(job.id, "job.id");
  if (!["cron", "at", "heartbeat", "webhook"].includes(job.type)) {
    throw new Error("job.type must be cron, at, heartbeat, or webhook");
  }
  requireId(job.target, "job.target");
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function waitForReload(statePath, changedAfter, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(statePath);
      if (metadata.mtimeMs >= changedAfter) {
        const state = record(await readJson(statePath), "jobs state");
        if (state.lastLoadError) throw new Error(`Scheduler rejected jobs.json: ${state.lastLoadError}`);
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the scheduler to validate jobs.json");
}

export async function applyJobsRequest(input, options = {}) {
  const request = record(input, "request");
  const stateDir = options.stateDir || await resolveCoordinatorStateDir(options.env);
  const jobsPath = join(stateDir, "jobs.json");
  const statePath = join(stateDir, "jobs-state.json");
  const existing = record(await readJson(jobsPath, { version: 3, jobs: [] }), "jobs file");
  if (!Array.isArray(existing.jobs)) throw new Error("jobs file has no jobs array");
  const state = record(await readJson(statePath, { fired: {} }), "jobs state");
  const fired = state.fired && typeof state.fired === "object" ? state.fired : {};
  const pruned = existing.jobs
    .filter((job) => job?.type === "at" && fired[job.id] !== undefined)
    .map((job) => job.id);
  let jobs = existing.jobs.filter((job) => !pruned.includes(job?.id));
  let result;

  if (request.operation === "list") {
    return { ok: true, operation: "list", stateDir, jobs };
  }
  if (request.operation === "add_at") {
    const id = requireId(request.id);
    const target = requireId(request.target, "target");
    if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("prompt is required");
    if ((request.at === undefined) === (request.in === undefined)) throw new Error('Provide exactly one of "at" or "in"');
    const at = request.in === undefined
      ? new Date(request.at).toISOString()
      : relativeTimestamp(request.in, (options.now || Date.now)());
    const job = { id, type: "at", target, at, prompt: request.prompt };
    if (jobs.some((entry) => entry?.id === id)) throw new Error(`Job already exists: ${id}`);
    jobs.push(job);
    result = { ok: true, operation: "add_at", job, pruned };
  } else if (request.operation === "upsert") {
    validateJobEnvelope(request.job);
    const index = jobs.findIndex((entry) => entry?.id === request.job.id);
    if (index === -1) jobs.push(request.job);
    else jobs[index] = request.job;
    result = { ok: true, operation: "upsert", job: request.job, created: index === -1, pruned };
  } else if (request.operation === "remove") {
    const id = requireId(request.id);
    if (!jobs.some((entry) => entry?.id === id)) throw new Error(`Unknown job: ${id}`);
    jobs = jobs.filter((entry) => entry?.id !== id);
    result = { ok: true, operation: "remove", removed: id, pruned };
  } else {
    throw new Error("operation must be list, add_at, upsert, or remove");
  }

  if (jobs.some((job) => !job?.target)) {
    throw new Error("Cannot upgrade jobs file to schema 3 while a job is missing target");
  }
  const updated = { version: 3, jobs };
  const changedAfter = Date.now();
  await atomicWrite(jobsPath, updated);
  if (options.validateReload !== false) {
    try {
      await waitForReload(statePath, changedAfter, options.reloadTimeoutMs ?? 5_000);
    } catch (error) {
      await atomicWrite(jobsPath, existing);
      throw error;
    }
  }
  return { ...result, stateDir };
}

async function main() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const result = await applyJobsRequest(JSON.parse(raw));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
