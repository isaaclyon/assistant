import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertRuntimeReady,
  readRuntimeMetadata,
  writeRuntimeMetadata,
} from "../src/runtime-metadata.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

describe("instance runtime readiness metadata", () => {
  it("writes private atomic metadata and verifies exact instance, SHA, and PID", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-runtime-metadata-"));
    const path = join(root, "instances", "shared", "runtime.json");
    await mkdir(join(root, "instances", "shared"), { recursive: true, mode: 0o700 });

    await writeRuntimeMetadata(path, {
      version: 1,
      instanceId: "shared",
      releaseSha: SHA,
      pid: 4242,
      status: "ready",
      principal: "household",
      telegramSurface: "household-group",
      workspaceCwd: "/srv/workspaces/shared",
      resourceRoot: `/srv/releases/${SHA}`,
      sessionFile: "/var/lib/bridge/instances/shared/sessions/current.jsonl",
      updatedAt: "2026-07-21T12:00:00.000Z",
    });

    const metadata = await readRuntimeMetadata(path);
    expect(
      assertRuntimeReady(metadata, {
        instanceId: "shared",
        releaseSha: SHA,
        pid: 4242,
      }),
    ).toEqual(metadata);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("token");
  });

  it("rejects missing, unhealthy, wrong-instance, wrong-SHA, and unstable PID metadata", () => {
    const ready = {
      version: 1 as const,
      instanceId: "isaac",
      releaseSha: SHA,
      pid: 99,
      status: "ready" as const,
      principal: "isaac" as const,
      telegramSurface: "private" as const,
      workspaceCwd: "/srv/workspaces/isaac",
      resourceRoot: `/srv/releases/${SHA}`,
      updatedAt: "2026-07-21T12:00:00.000Z",
    };

    expect(() => assertRuntimeReady(undefined, { instanceId: "isaac", releaseSha: SHA, pid: 99 })).toThrow(/missing/i);
    expect(() => assertRuntimeReady({ ...ready, status: "starting" }, { instanceId: "isaac", releaseSha: SHA, pid: 99 })).toThrow(/not ready/i);
    expect(() => assertRuntimeReady(ready, { instanceId: "emma", releaseSha: SHA, pid: 99 })).toThrow(/instance/i);
    expect(() => assertRuntimeReady(ready, { instanceId: "isaac", releaseSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", pid: 99 })).toThrow(/release/i);
    expect(() => assertRuntimeReady(ready, { instanceId: "isaac", releaseSha: SHA, pid: 100 })).toThrow(/PID/i);
  });
});
