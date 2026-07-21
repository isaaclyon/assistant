import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBridgeConfig } from "./config.js";
import { resolveHeartbeatCheckerPath } from "./heartbeat.js";
import { parseJobsFile } from "./jobs.js";

const config = resolveBridgeConfig();
const jobsPath = join(config.stateDir, "jobs.json");
const statePath = join(config.stateDir, "jobs-state.json");

let raw: string;
try {
  raw = await readFile(jobsPath, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    process.stdout.write(`No jobs file at ${jobsPath} (that is fine; no jobs are scheduled).\n`);
    process.exit(0);
  }
  throw error;
}

try {
  const jobs = parseJobsFile(raw);
  for (const job of jobs) {
    if (job.type !== "heartbeat") continue;
    const checkerPath = resolveHeartbeatCheckerPath(job.checker.id);
    try {
      await access(checkerPath);
    } catch {
      throw new Error(`heartbeat '${job.id}' checker is not built: ${checkerPath}`);
    }
  }
  process.stdout.write(`${jobsPath} is valid (${jobs.length} job(s)):\n`);
  for (const job of jobs) {
    let detail: string;
    if (job.type === "cron" || job.type === "heartbeat") {
      detail = `${job.schedule}${job.tz ? ` ${job.tz}` : ""}`;
    } else if (job.type === "at") {
      detail = job.at;
    } else {
      detail = `POST /hook/${job.id}`;
    }
    process.stdout.write(`  - ${job.id} (${job.type}): ${detail}\n`);
  }
} catch (error) {
  process.stderr.write(`${jobsPath} is INVALID:\n`);
  process.stderr.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

try {
  const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
  const lastLoadError =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>).lastLoadError
      : null;
  if (typeof lastLoadError === "string") {
    process.stderr.write(`Bridge last rejected a jobs.json load with: ${lastLoadError}\n`);
    process.stderr.write("(It clears after the bridge reloads a valid file.)\n");
  }
} catch {
  // No state file yet; nothing to report.
}
