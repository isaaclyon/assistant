import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBridgeConfig } from "./config.js";
import { parseJobsFile } from "./jobs.js";

const config = resolveBridgeConfig();
const jobsPath = join(config.stateDir, "jobs.json");
const statePath = join(config.stateDir, "jobs-state.json");

let raw: string;
try {
  raw = await readFile(jobsPath, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    console.log(`No jobs file at ${jobsPath} (that is fine; no jobs are scheduled).`);
    process.exit(0);
  }
  throw error;
}

try {
  const jobs = parseJobsFile(raw);
  console.log(`${jobsPath} is valid (${jobs.length} job(s)):`);
  for (const job of jobs) {
    const detail =
      job.type === "cron" || job.type === "heartbeat"
        ? `${job.schedule}${job.tz ? ` ${job.tz}` : ""}`
        : job.type === "at"
          ? job.at
          : `POST /hook/${job.id}`;
    console.log(`  - ${job.id} (${job.type}): ${detail}`);
  }
} catch (error) {
  console.error(`${jobsPath} is INVALID:`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

try {
  const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
  const lastLoadError =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>).lastLoadError
      : null;
  if (typeof lastLoadError === "string") {
    console.error(`Bridge last rejected a jobs.json load with: ${lastLoadError}`);
    console.error("(It clears after the bridge reloads a valid file.)");
  }
} catch {
  // No state file yet; nothing to report.
}
