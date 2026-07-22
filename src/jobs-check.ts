import { readFile } from "node:fs/promises";

import { loadBridgeRuntimeConfig } from "./config.js";
import { loadValidatedJobs } from "./jobs-validation.js";

const config = await loadBridgeRuntimeConfig();
const fleetInstanceIds =
  "configuredInstanceIds" in config ? config.configuredInstanceIds : undefined;

try {
  const { jobsPath, statePath, jobs, exists } = await loadValidatedJobs({
    stateDir: config.stateDir,
    ...(fleetInstanceIds ? { configuredInstanceIds: fleetInstanceIds } : {}),
  });
  if (!exists) {
    process.stdout.write(
      `No jobs file at ${jobsPath} (that is fine; no jobs are scheduled).\n`,
    );
    process.exit(0);
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
  try {
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    const lastLoadError =
      typeof state === "object" && state !== null
        ? (state as Record<string, unknown>).lastLoadError
        : null;
    if (typeof lastLoadError === "string") {
      process.stderr.write(
        `Bridge last rejected a jobs.json load with: ${lastLoadError}\n`,
      );
      process.stderr.write("(It clears after the bridge reloads a valid file.)\n");
    }
  } catch {
    // No state file yet; nothing to report.
  }
} catch (error) {
  process.stderr.write(`${config.stateDir}/jobs.json is INVALID:\n`);
  process.stderr.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
