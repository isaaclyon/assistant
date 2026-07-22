import { describe, expect, it, vi } from "vitest";

import { deployBridgeFleet } from "../src/fleet-deployment.js";

const TARGET_SHA = "1234567890abcdef1234567890abcdef12345678";
const PREVIOUS_SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const INSTANCES = ["isaac", "emma", "shared", "builder"] as const;

describe("atomic fleet deployment", () => {
  it("preflights and builds once, then verifies every instance on one SHA", async () => {
    const calls: string[] = [];
    const result = await deployBridgeFleet({
      instanceIds: INSTANCES,
      targetSha: TARGET_SHA,
      previousSha: PREVIOUS_SHA,
      adapter: {
        preflight: async () => calls.push("preflight"),
        buildRelease: async () => calls.push("build"),
        activate: async (id) => calls.push(`activate:${id}`),
        waitUntilReady: async (id, sha) => {
          calls.push(`ready:${id}:${sha}`);
          return { instanceId: id, releaseSha: sha, pid: 100 + calls.length };
        },
        rollback: async (id) => calls.push(`rollback:${id}`),
      },
    });

    expect(calls.filter((call) => call === "build")).toHaveLength(1);
    expect(result.releaseSha).toBe(TARGET_SHA);
    expect(result.instances.map((item) => item.instanceId)).toEqual(INSTANCES);
    expect(result.instances.every((item) => item.releaseSha === TARGET_SHA)).toBe(true);
    expect(calls.some((call) => call.startsWith("rollback:"))).toBe(false);
  });

  it("rolls every changed instance back after a partial activation failure", async () => {
    const calls: string[] = [];
    const activate = vi.fn(async (id: string) => {
      calls.push(`activate:${id}`);
      if (id === "shared") throw new Error("shared failed readiness");
    });

    await expect(
      deployBridgeFleet({
        instanceIds: INSTANCES,
        targetSha: TARGET_SHA,
        previousSha: PREVIOUS_SHA,
        adapter: {
          preflight: async () => undefined,
          buildRelease: async () => undefined,
          activate,
          waitUntilReady: async (id, sha) => ({
            instanceId: id,
            releaseSha: sha,
            pid: 200,
          }),
          rollback: async (id, sha) => calls.push(`rollback:${id}:${sha}`),
        },
      }),
    ).rejects.toThrow(/shared failed readiness/);

    expect(activate).toHaveBeenCalledTimes(3);
    expect(calls.slice(-3)).toEqual([
      `rollback:shared:${PREVIOUS_SHA}`,
      `rollback:emma:${PREVIOUS_SHA}`,
      `rollback:isaac:${PREVIOUS_SHA}`,
    ]);
  });

  it("reports rollback failures without hiding the activation cause", async () => {
    await expect(
      deployBridgeFleet({
        instanceIds: ["isaac"],
        targetSha: TARGET_SHA,
        previousSha: PREVIOUS_SHA,
        adapter: {
          preflight: async () => undefined,
          buildRelease: async () => undefined,
          activate: async () => {
            throw new Error("activation failed");
          },
          waitUntilReady: async () => {
            throw new Error("not reached");
          },
          rollback: async () => {
            throw new Error("rollback failed");
          },
        },
      }),
    ).rejects.toThrow(/activation failed.*rollback failed/is);
  });
});
