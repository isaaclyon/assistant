import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { loadValidatedJobs } from "../src/jobs-validation.js";

describe("deployment jobs validation", () => {
  it("loads the selected coordinator state and requires known fleet targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-jobs-validation-"));
    const stateDir = join(root, "instances", "isaac");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "jobs.json"),
      JSON.stringify({
        version: 3,
        jobs: [
          {
            id: "household-reminder",
            type: "cron",
            schedule: "0 8 * * *",
            target: "shared",
            prompt: "Household reminder",
          },
        ],
      }),
    );

    await expect(
      loadValidatedJobs({
        stateDir,
        configuredInstanceIds: ["isaac", "emma", "shared", "builder"],
        checkHeartbeatChecker: vi.fn(),
      }),
    ).resolves.toMatchObject({
      jobsPath: join(stateDir, "jobs.json"),
      jobs: [expect.objectContaining({ id: "household-reminder", target: "shared" })],
    });

    await writeFile(
      join(stateDir, "jobs.json"),
      JSON.stringify({
        version: 3,
        jobs: [
          {
            id: "retired-target",
            type: "at",
            at: "2030-01-01T00:00:00.000Z",
            target: "retired",
            prompt: "Must fail",
          },
        ],
      }),
    );
    await expect(
      loadValidatedJobs({
        stateDir,
        configuredInstanceIds: ["isaac", "emma", "shared", "builder"],
        checkHeartbeatChecker: vi.fn(),
      }),
    ).rejects.toThrow(/unknown target "retired"/i);
  });

  it("preserves target-optional singleton validation and checks compiled heartbeat references", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-jobs-singleton-validation-"));
    await writeFile(
      join(root, "jobs.json"),
      JSON.stringify({
        version: 2,
        jobs: [
          {
            id: "health",
            type: "heartbeat",
            schedule: "*/5 * * * *",
            checker: { id: "synthetic" },
            rule: { type: "changed" },
            onTrigger: { type: "prompt", prompt: "Changed" },
          },
        ],
      }),
    );
    const checkHeartbeatChecker = vi.fn(async () => undefined);

    const result = await loadValidatedJobs({
      stateDir: root,
      checkHeartbeatChecker,
    });

    expect(result.jobs).toHaveLength(1);
    expect(checkHeartbeatChecker).toHaveBeenCalledWith("synthetic");
  });
});
