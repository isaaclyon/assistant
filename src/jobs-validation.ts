import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveHeartbeatCheckerPath } from "./heartbeat.js";
import { parseJobsFile, type JobDefinition } from "./jobs.js";

export interface LoadValidatedJobsOptions {
  stateDir: string;
  configuredInstanceIds?: readonly string[];
  checkHeartbeatChecker?: (checkerId: string) => Promise<void>;
}

export interface ValidatedJobs {
  jobsPath: string;
  statePath: string;
  jobs: JobDefinition[];
  exists: boolean;
}

async function checkCompiledHeartbeatChecker(checkerId: string): Promise<void> {
  const checkerPath = resolveHeartbeatCheckerPath(checkerId);
  try {
    await access(checkerPath);
  } catch {
    throw new Error(`heartbeat checker is not built: ${checkerPath}`);
  }
}

export async function loadValidatedJobs({
  stateDir,
  configuredInstanceIds,
  checkHeartbeatChecker = checkCompiledHeartbeatChecker,
}: LoadValidatedJobsOptions): Promise<ValidatedJobs> {
  const jobsPath = join(stateDir, "jobs.json");
  const statePath = join(stateDir, "jobs-state.json");
  let raw: string;
  try {
    raw = await readFile(jobsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { jobsPath, statePath, jobs: [], exists: false };
    }
    throw error;
  }

  const fleetTargets = configuredInstanceIds
    ? new Set(configuredInstanceIds)
    : undefined;
  const jobs = parseJobsFile(raw, {
    ...(fleetTargets
      ? { validTargets: fleetTargets, requireTargets: true }
      : {}),
  });
  for (const job of jobs) {
    if (job.type !== "heartbeat") continue;
    try {
      await checkHeartbeatChecker(job.checker.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`heartbeat '${job.id}' checker validation failed: ${message}`, {
        cause: error,
      });
    }
  }
  return { jobsPath, statePath, jobs, exists: true };
}
