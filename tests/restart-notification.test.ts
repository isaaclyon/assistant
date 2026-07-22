import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  markRestartPending,
  notifyPendingRestart,
} from "../src/restart-notification.js";

describe("restart notification", () => {
  it("persists a pending notification before the bridge exits", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-telegram-restart-"));

    markRestartPending(stateDir);

    await expect(readFile(join(stateDir, "restart-pending.json"), "utf8")).resolves
      .toBe("");
  });

  it("notifies the paired Telegram user and clears the marker after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-restart-"));
    const stateDir = join(root, "state");
    const agentDir = join(root, "agent");
    await mkdir(stateDir);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({ botToken: "test-token", allowedUserId: 42 }),
    );
    markRestartPending(stateDir);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await expect(
      notifyPendingRestart({ stateDir, agentDir, fetchImpl }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: 42,
          text: "✅ Bridge restarted successfully and is back online.",
        }),
      }),
    );
    await expect(readFile(join(stateDir, "restart-pending.json"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("keeps the marker when Telegram rejects the confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-restart-"));
    const stateDir = join(root, "state");
    const agentDir = join(root, "agent");
    await mkdir(stateDir);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({ botToken: "test-token", allowedUserId: 42 }),
    );
    markRestartPending(stateDir);

    await expect(
      notifyPendingRestart({
        stateDir,
        agentDir,
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ ok: false }), { status: 200 }),
        ),
      }),
    ).rejects.toThrow(/Telegram restart confirmation failed/);
    await expect(readFile(join(stateDir, "restart-pending.json"), "utf8")).resolves
      .toBe("");
  });

  it("routes a private instance restart through only its named Telegram profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-profile-restart-"));
    const stateDir = join(root, "state", "instances", "emma");
    const agentDir = join(root, "agent");
    await mkdir(stateDir, { recursive: true });
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({
        botToken: "default-token",
        allowedUserId: 1,
        profiles: {
          emma: { botToken: "emma-token", allowedUserId: 84 },
        },
      }),
    );
    markRestartPending(stateDir, {
      instanceId: "emma",
      telegramProfile: "emma",
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await expect(
      notifyPendingRestart({
        stateDir,
        agentDir,
        instanceId: "emma",
        telegramProfile: "emma",
        telegramSurface: { type: "private" },
        fetchImpl,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telegram.org/botemma-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 84,
          text: "✅ Bridge restarted successfully and is back online.",
        }),
      }),
    );
  });

  it("refuses to consume another instance's restart marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-cross-restart-"));
    const stateDir = join(root, "state");
    const agentDir = join(root, "agent");
    await mkdir(stateDir);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({ profiles: { emma: { botToken: "token", allowedUserId: 84 } } }),
    );
    markRestartPending(stateDir, {
      instanceId: "isaac",
      telegramProfile: "isaac",
    });

    await expect(
      notifyPendingRestart({
        stateDir,
        agentDir,
        instanceId: "emma",
        telegramProfile: "emma",
        telegramSurface: { type: "private" },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/belongs to instance isaac/i);
    await expect(readFile(join(stateDir, "restart-pending.json"), "utf8")).resolves
      .toContain('"instanceId": "isaac"');
  });

  it("routes Shared restart confirmation to the configured household group", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-shared-restart-"));
    const stateDir = join(root, "state");
    const agentDir = join(root, "agent");
    await mkdir(stateDir);
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({
        profiles: {
          household: { botToken: "household-token", allowedUserId: 42 },
        },
      }),
    );
    markRestartPending(stateDir, {
      instanceId: "shared",
      telegramProfile: "household",
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await notifyPendingRestart({
      stateDir,
      agentDir,
      instanceId: "shared",
      telegramProfile: "household",
      telegramSurface: {
        type: "household-group",
        chatId: -100123,
        actors: { isaac: 42, emma: 84 },
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telegram.org/bothousehold-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: -100123,
          text: "✅ Bridge restarted successfully and is back online.",
        }),
      }),
    );
  });
});
