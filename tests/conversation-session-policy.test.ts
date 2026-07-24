import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationSessionPolicy,
  loadConversationSessionState,
  planConversationSessionPreparation,
} from "../src/conversation-session-policy.js";

const HOUR = 60 * 60 * 1_000;
const baseline = Date.parse("2026-07-23T02:00:00.000Z");

describe("conversation session planning", () => {
  it("adopts the current session on first deployment and starts at the first human prompt", () => {
    expect(
      planConversationSessionPreparation(undefined, {
        trigger: "job:cron",
        nowMs: baseline + 12 * HOUR,
        timeoutMs: 8 * HOUR,
        currentSessionId: "session-a",
      }),
    ).toEqual({ kind: "unchanged" });

    expect(
      planConversationSessionPreparation(undefined, {
        trigger: "telegram",
        nowMs: baseline,
        timeoutMs: 8 * HOUR,
        currentSessionId: "session-a",
      }),
    ).toMatchObject({
      kind: "persist",
      state: { lastHumanPromptAt: "2026-07-23T02:00:00.000Z" },
    });
  });

  it("keeps prompts before the boundary in-session and rotates the first event at the boundary", () => {
    const state = {
      version: 1 as const,
      lastHumanPromptAt: new Date(baseline).toISOString(),
      rotatedForHumanPromptAt: null,
    };
    expect(
      planConversationSessionPreparation(state, {
        trigger: "telegram",
        nowMs: baseline + 8 * HOUR - 1,
        timeoutMs: 8 * HOUR,
        currentSessionId: "session-a",
      }),
    ).toMatchObject({ kind: "persist", state: { rotatedForHumanPromptAt: null } });
    expect(
      planConversationSessionPreparation(state, {
        trigger: "job:cron",
        nowMs: baseline + 8 * HOUR,
        timeoutMs: 8 * HOUR,
        currentSessionId: "session-a",
      }),
    ).toMatchObject({
      kind: "replace",
      pendingState: {
        pendingReplacement: {
          kind: "automatic-job",
          fromSessionId: "session-a",
          humanPromptAt: new Date(baseline).toISOString(),
        },
      },
      successState: { rotatedForHumanPromptAt: new Date(baseline).toISOString() },
    });
  });

  it("does not let repeated jobs rotate one human-idle period twice", () => {
    const state = {
      version: 1 as const,
      lastHumanPromptAt: new Date(baseline).toISOString(),
      rotatedForHumanPromptAt: new Date(baseline).toISOString(),
    };
    expect(
      planConversationSessionPreparation(state, {
        trigger: "job:webhook",
        nowMs: baseline + 20 * HOUR,
        timeoutMs: 8 * HOUR,
        currentSessionId: "session-b",
      }),
    ).toEqual({ kind: "already-rotated" });
  });

  it("recovers a replacement that succeeded before its final state write", () => {
    const state = {
      version: 1 as const,
      lastHumanPromptAt: new Date(baseline).toISOString(),
      rotatedForHumanPromptAt: null,
      pendingReplacement: {
        kind: "automatic-job" as const,
        fromSessionId: "session-a",
        humanPromptAt: new Date(baseline).toISOString(),
        requestedAt: new Date(baseline + 10 * HOUR).toISOString(),
      },
    };
    expect(
      planConversationSessionPreparation(state, {
        trigger: "job:cron",
        nowMs: baseline + 10 * HOUR + 1,
        timeoutMs: 8 * HOUR,
        currentSessionId: "session-b",
      }),
    ).toMatchObject({
      kind: "persist",
      state: {
        rotatedForHumanPromptAt: new Date(baseline).toISOString(),
      },
    });
  });
});

describe("ConversationSessionPolicy", () => {
  it("persists private atomic state and survives restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-policy-"));
    const path = join(root, "conversation-session-state.json");
    const policy = await ConversationSessionPolicy.open({
      path,
      timeoutMs: 8 * HOUR,
      nowMs: () => baseline,
    });
    await policy.prepare("telegram", "session-a", async () => {
      throw new Error("should not replace while establishing a baseline");
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadConversationSessionState(path)).toMatchObject({
      lastHumanPromptAt: new Date(baseline).toISOString(),
    });
    const restarted = await ConversationSessionPolicy.open({
      path,
      timeoutMs: 8 * HOUR,
      nowMs: () => baseline + HOUR,
    });
    await expect(
      restarted.prepare("job:cron", "session-a", async () => ({
        cancelled: false,
        sessionId: "session-b",
      })),
    ).resolves.toEqual({ sessionReplaced: false });
  });

  it("marks a period only after replacement succeeds and retries failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-policy-retry-"));
    const path = join(root, "conversation-session-state.json");
    let now = baseline;
    const policy = await ConversationSessionPolicy.open({
      path,
      timeoutMs: 8 * HOUR,
      nowMs: () => now,
    });
    await policy.prepare("telegram", "session-a", async () => ({
      cancelled: false,
      sessionId: "unused",
    }));
    now += 9 * HOUR;
    const replace = vi
      .fn()
      .mockRejectedValueOnce(new Error("replacement failed"))
      .mockResolvedValueOnce({ cancelled: false, sessionId: "session-b" });
    await expect(policy.prepare("job:cron", "session-a", replace)).rejects.toThrow(
      /replacement failed/,
    );
    await expect(policy.prepare("job:cron", "session-a", replace)).resolves.toEqual({
      sessionReplaced: true,
    });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(await loadConversationSessionState(path)).toMatchObject({
      rotatedForHumanPromptAt: new Date(baseline).toISOString(),
    });
  });

  it("does not replace when the pre-replacement state write fails", async () => {
    const replace = vi.fn(async () => ({ cancelled: false, sessionId: "session-b" }));
    let writes = 0;
    let now = baseline;
    const policy = await ConversationSessionPolicy.open({
      path: "/unused/conversation-session-state.json",
      timeoutMs: 8 * HOUR,
      nowMs: () => now,
      saveState: async () => {
        writes += 1;
        if (writes > 1) throw new Error("disk full");
      },
    });
    await policy.prepare("telegram", "session-a", replace);
    now += 9 * HOUR;
    await expect(
      policy.prepare("job:cron", "session-a", replace),
    ).rejects.toThrow(/disk full/);
    expect(replace).not.toHaveBeenCalled();
  });

  it("serializes concurrent human and job eligibility to one replacement", async () => {
    let now = baseline;
    const policy = await ConversationSessionPolicy.open({
      path: "/unused/conversation-session-state.json",
      timeoutMs: 8 * HOUR,
      nowMs: () => now,
      saveState: async () => undefined,
    });
    await policy.prepare("telegram", "session-a", async () => ({
      cancelled: false,
      sessionId: "unused",
    }));
    now += 9 * HOUR;
    const replace = vi.fn(async () => ({ cancelled: false, sessionId: "session-b" }));
    await expect(
      Promise.all([
        policy.prepare("job:cron", "session-a", replace),
        policy.prepare("telegram", "session-a", replace),
      ]),
    ).resolves.toEqual([
      { sessionReplaced: true },
      { sessionReplaced: false },
    ]);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("fails safely on malformed state without replacing", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-policy-invalid-"));
    const path = join(root, "conversation-session-state.json");
    await writeFile(path, '{"version":1,"lastHumanPromptAt":"not-a-date"}\n', {
      mode: 0o600,
    });
    await expect(
      ConversationSessionPolicy.open({ path, timeoutMs: 8 * HOUR }),
    ).rejects.toThrow(/conversation session state.*lastHumanPromptAt/i);
  });

  it("a successful manual new establishes a fresh human idle interval", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-policy-manual-"));
    const path = join(root, "conversation-session-state.json");
    const policy = await ConversationSessionPolicy.open({
      path,
      timeoutMs: 8 * HOUR,
      nowMs: () => baseline + 20 * HOUR,
    });
    await expect(
      policy.manualNew("session-a", async () => ({
        cancelled: false,
        sessionId: "session-b",
      })),
    ).resolves.toEqual({ cancelled: false, sessionId: "session-b" });
    await expect(
      policy.prepare("job:cron", "session-b", async () => {
        throw new Error("must not immediately rotate");
      }),
    ).resolves.toEqual({ sessionReplaced: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      lastHumanPromptAt: new Date(baseline + 20 * HOUR).toISOString(),
      rotatedForHumanPromptAt: null,
    });
  });

  it("recovers a completed manual replacement instead of replacing twice", async () => {
    let writes = 0;
    const saveState = vi.fn(async () => {
      writes += 1;
      if (writes === 2) throw new Error("final state write failed");
    });
    const policy = await ConversationSessionPolicy.open({
      path: "/unused/conversation-session-state.json",
      timeoutMs: 8 * HOUR,
      nowMs: () => baseline,
      saveState,
    });
    const replace = vi.fn(async () => ({
      cancelled: false,
      sessionId: "session-b",
    }));

    await expect(policy.manualNew("session-a", replace)).rejects.toThrow(
      /final state write failed/,
    );
    await expect(policy.manualNew("session-b", replace)).resolves.toEqual({
      cancelled: false,
      sessionId: "session-b",
    });
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
