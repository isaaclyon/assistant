import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { TELEGRAM_LOCK_STALE_HEARTBEAT_MS } from "../src/config.js";
import { startBridgeHost } from "../src/host.js";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

type RegisterTelegramHostNewSession = (
  provider: () => Promise<{ cancelled: boolean }>,
) => () => void;

async function loadPinnedTelegramHostApi(): Promise<{
  registerTelegramHostNewSession: RegisterTelegramHostNewSession;
}> {
  // The pinned extension intentionally ships TypeScript source. Keeping the
  // specifier dynamic lets Vitest exercise its public API without making this
  // host's emitted JavaScript import TypeScript from node_modules (ADR-0002).
  const specifier: string = "@llblab/pi-telegram/host";
  return (await import(specifier)) as {
    registerTelegramHostNewSession: RegisterTelegramHostNewSession;
  };
}

interface PinnedSessionReplacementRuntime {
  request(target: { chatId: number; threadId?: number }): {
    accepted: boolean;
    reason?: string;
  };
  flushAfterUpdatePersisted(): boolean;
  onSessionStart(): Promise<void>;
}

async function loadPinnedSessionReplacementFactory(): Promise<{
  createTelegramSessionReplacementRuntime(deps: {
    sendTargetText: (
      target: { chatId: number; threadId?: number },
      text: string,
    ) => Promise<void>;
  }): PinnedSessionReplacementRuntime;
}> {
  const path = join(
    dirname(resolveTelegramExtensionPath()),
    "lib",
    "session-replacement.ts",
  );
  return (await import(pathToFileURL(path).href)) as {
    createTelegramSessionReplacementRuntime(deps: {
      sendTargetText: (
        target: { chatId: number; threadId?: number },
        text: string,
      ) => Promise<void>;
    }): PinnedSessionReplacementRuntime;
  };
}

async function loadPinnedLockApi(): Promise<{
  TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS: number;
  createTelegramLockRuntime(options: {
    locksPath: string;
    pid: number;
    instanceId: string;
    getNowMs: () => number;
    staleHeartbeatMs: number;
  }): {
    acquire(context: { cwd: string }): { ok: boolean };
  };
}> {
  const path = join(dirname(resolveTelegramExtensionPath()), "lib", "locks.ts");
  return (await import(pathToFileURL(path).href)) as Awaited<
    ReturnType<typeof loadPinnedLockApi>
  >;
}

describe("startBridgeHost", () => {
  it("lets the Telegram host capability replace and rebind the persistent session", async () => {
    const { registerTelegramHostNewSession } = await loadPinnedTelegramHostApi();
    const { createTelegramSessionReplacementRuntime } =
      await loadPinnedSessionReplacementFactory();
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-new-session-"));
    const extensionPath = join(root, "new-session-extension.mjs");
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-sol",
      }),
    );
    await writeFile(
      extensionPath,
      `export default function(pi) {
        pi.registerCommand("test-ping", {
          description: "Verify extension commands are rebound after replacement",
          handler: async (_args, ctx) => {
            ctx.sessionManager.appendCustomMessageEntry("test-ping", "ok", false);
          },
        });
      }\n`,
    );
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      expect(() =>
        registerTelegramHostNewSession(async () => ({ cancelled: false })),
      ).toThrow(/already registered/);
      const originalSessionFile = host.runtime.session.sessionFile;
      expect(originalSessionFile).toContain(join(root, "state", "sessions"));
      expect(host.runtime.session.model).toEqual(
        expect.objectContaining({ provider: "openai-codex", id: "gpt-5.6-sol" }),
      );
      expect(host.runtime.session.getActiveToolNames()).toEqual(
        expect.arrayContaining([
          "exec_command",
          "write_stdin",
          "apply_patch",
          "view_image",
          "web_run",
        ]),
      );
      expect(host.runtime.session.getActiveToolNames()).not.toContain("imagegen");

      const messages: string[] = [];
      const replacement = createTelegramSessionReplacementRuntime({
        sendTargetText: async (_target, text) => {
          messages.push(text);
        },
      });
      expect(replacement.request({ chatId: 7, threadId: 42 })).toEqual({
        accepted: true,
      });
      expect(replacement.flushAfterUpdatePersisted()).toBe(true);
      await vi.waitFor(() => {
        expect(host.runtime.session.sessionFile).not.toBe(originalSessionFile);
      });
      await replacement.onSessionStart();
      expect(messages).toContain("✅ New session started in this thread.");

      const replacementSessionFile = host.runtime.session.sessionFile;
      expect(replacementSessionFile).toContain(join(root, "state", "sessions"));
      expect(replacementSessionFile).not.toBe(originalSessionFile);
      await expect(
        host.runtime.session.prompt("/test-ping", { source: "rpc" }),
      ).resolves.toBeUndefined();
      expect(
        host.runtime.session.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom_message" && entry.customType === "test-ping",
          ),
      ).toBe(true);
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    const unregister = registerTelegramHostNewSession(async () => ({ cancelled: false }));
    unregister();
  }, 20_000);

  it("matches the pinned fork's heartbeat lock contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-lock-contract-"));
    const locksPath = join(root, "locks.json");
    const pinnedLocks = await loadPinnedLockApi();
    expect(pinnedLocks.TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS).toBe(
      TELEGRAM_LOCK_STALE_HEARTBEAT_MS,
    );
    const lock = pinnedLocks.createTelegramLockRuntime({
      locksPath,
      pid: 99,
      instanceId: "pinned-fork-test",
      getNowMs: () => 1_000,
      staleHeartbeatMs: pinnedLocks.TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
    });

    expect(lock.acquire({ cwd: root }).ok).toBe(true);
    const { readDefaultTelegramLock, shouldRecoverTelegramOwnership } =
      await import("../src/config.js");
    const lockView = await readDefaultTelegramLock(locksPath);
    expect(lockView).toEqual(
      expect.objectContaining({
        pid: 99,
        cwd: root,
        heartbeatMs: 1_000,
      }),
    );
    expect(
      shouldRecoverTelegramOwnership(lockView, 10, () => true, 6_001),
    ).toBe(true);
  });

  it("takes over a stale heartbeat whose pid was reused by this host", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-stale-lock-"));
    const agentDir = join(root, "agent");
    const extensionPath = join(root, "connect-extension.mjs");
    const locksPath = join(agentDir, "locks.json");
    await writeFile(
      extensionPath,
      `import { writeFileSync } from "node:fs";
      export default function(pi) {
        pi.registerCommand("telegram-connect", {
          description: "Record ownership recovery",
          handler: async (_args, ctx) => {
            writeFileSync(${JSON.stringify(locksPath)}, JSON.stringify({
              "@llblab/pi-telegram": {
                pid: process.pid,
                cwd: ctx.cwd,
                heartbeatMs: Date.now(),
              },
            }));
            ctx.sessionManager.appendCustomMessageEntry("telegram-connect", "ok", false);
          },
        });
      }\n`,
    );
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "telegram.json"), JSON.stringify({ botToken: "test" }));
    await writeFile(
      locksPath,
      JSON.stringify({
        "@llblab/pi-telegram": { pid: process.pid, heartbeatMs: 1_000 },
      }),
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      telegramExtensionPath: extensionPath,
      isProcessAlive: () => true,
      nowMs: () => 6_001,
    });

    try {
      expect(
        host.runtime.session.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === "telegram-connect",
          ),
      ).toBe(true);
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("recovers polling after an external live owner exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-owner-exit-"));
    const agentDir = join(root, "agent");
    const extensionPath = join(root, "connect-extension.mjs");
    const locksPath = join(agentDir, "locks.json");
    await writeFile(
      extensionPath,
      `import { writeFileSync } from "node:fs";
      export default function(pi) {
        pi.registerCommand("telegram-connect", {
          description: "Record ownership recovery",
          handler: async (_args, ctx) => {
            writeFileSync(${JSON.stringify(locksPath)}, JSON.stringify({
              "@llblab/pi-telegram": {
                pid: process.pid,
                cwd: ctx.cwd,
                heartbeatMs: Date.now(),
              },
            }));
            ctx.sessionManager.appendCustomMessageEntry("telegram-connect", "ok", false);
          },
        });
      }\n`,
    );
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "telegram.json"), JSON.stringify({ botToken: "test" }));
    await writeFile(
      locksPath,
      JSON.stringify({
        "@llblab/pi-telegram": { pid: 99, heartbeatMs: Date.now() },
      }),
    );
    let ownerAlive = true;

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      telegramExtensionPath: extensionPath,
      isProcessAlive: () => ownerAlive,
      ownershipMonitorIntervalMs: 10,
    });

    try {
      expect(
        host.runtime.session.sessionManager.getEntries(),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ customType: "telegram-connect" }),
        ]),
      );
      ownerAlive = false;
      await vi.waitFor(() => {
        expect(
          host.runtime.session.sessionManager.getEntries(),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ customType: "telegram-connect" }),
          ]),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(
        host.runtime.session.sessionManager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === "telegram-connect",
          ),
      ).toHaveLength(1);
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("serializes overlapping ownership monitor checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-monitor-"));
    const agentDir = join(root, "agent");
    const extensionPath = join(root, "noop-extension.mjs");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "telegram.json"), JSON.stringify({ botToken: "test" }));
    await writeFile(extensionPath, "export default function() {}\n");
    let reads = 0;
    let concurrentReads = 0;
    let maximumConcurrentReads = 0;
    const readTelegramLock = async () => {
      reads += 1;
      if (reads === 1) return { pid: 99, heartbeatMs: Date.now() };
      concurrentReads += 1;
      maximumConcurrentReads = Math.max(maximumConcurrentReads, concurrentReads);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrentReads -= 1;
      return { pid: 99, heartbeatMs: Date.now() };
    };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      telegramExtensionPath: extensionPath,
      isProcessAlive: () => true,
      ownershipMonitorIntervalMs: 1,
      readTelegramLock,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(maximumConcurrentReads).toBe(1);
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("waits for an in-flight ownership check before disposing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-monitor-dispose-"));
    const agentDir = join(root, "agent");
    const extensionPath = join(root, "connect-extension.mjs");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "telegram.json"), JSON.stringify({ botToken: "test" }));
    await writeFile(
      extensionPath,
      `export default function(pi) {
        pi.registerCommand("telegram-connect", {
          description: "Record an unsafe late recovery",
          handler: async (_args, ctx) => {
            ctx.sessionManager.appendCustomMessageEntry("telegram-connect", "late", false);
          },
        });
      }\n`,
    );
    let reads = 0;
    let releaseRead: (() => void) | undefined;
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    const readTelegramLock = async () => {
      reads += 1;
      if (reads === 1) return { pid: 99, heartbeatMs: Date.now() };
      notifyReadStarted?.();
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return undefined;
    };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      telegramExtensionPath: extensionPath,
      isProcessAlive: () => true,
      ownershipMonitorIntervalMs: 1,
      readTelegramLock,
    });

    try {
      await readStarted;
      let disposed = false;
      const disposing = host.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(disposed).toBe(false);
      releaseRead?.();
      await disposing;
      expect(
        host.runtime.session.sessionManager.getEntries(),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ customType: "telegram-connect" }),
        ]),
      );
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("still cleans up when an in-flight ownership check fails during disposal", async () => {
    const { registerTelegramHostNewSession } = await loadPinnedTelegramHostApi();
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-monitor-error-"));
    const agentDir = join(root, "agent");
    const extensionPath = join(root, "noop-extension.mjs");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "telegram.json"), JSON.stringify({ botToken: "test" }));
    await writeFile(extensionPath, "export default function() {}\n");
    let reads = 0;
    let rejectRead: ((error: Error) => void) | undefined;
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    const readTelegramLock = async () => {
      reads += 1;
      if (reads === 1) return { pid: 99, heartbeatMs: Date.now() };
      notifyReadStarted?.();
      return new Promise<never>((_resolve, reject) => {
        rejectRead = reject;
      });
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      logger,
      telegramExtensionPath: extensionPath,
      isProcessAlive: () => true,
      ownershipMonitorIntervalMs: 1,
      readTelegramLock,
    });

    try {
      await readStarted;
      const disposing = host.dispose();
      rejectRead?.(new Error("lock read failed"));
      await expect(disposing).resolves.toBeUndefined();
      const unregister = registerTelegramHostNewSession(async () => ({
        cancelled: false,
      }));
      unregister();
    } finally {
      await host.dispose().catch(() => undefined);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("cleans up the runtime and host capability after configuration read failure", async () => {
    const { registerTelegramHostNewSession } = await loadPinnedTelegramHostApi();
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-config-error-"));
    const agentDir = join(root, "agent");
    const extensionPath = join(root, "noop-extension.mjs");
    await mkdir(join(agentDir, "telegram.json"), { recursive: true });
    await writeFile(extensionPath, "export default function() {}\n");

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      await expect(
        startBridgeHost({
          config: {
            agentDir,
            cwd: root,
            sessionDir: join(root, "state", "sessions"),
            stateDir: join(root, "state"),
          },
          telegramExtensionPath: extensionPath,
        }),
      ).rejects.toThrow(/Could not read JSON file/);
      const unregister = registerTelegramHostNewSession(async () => ({
        cancelled: false,
      }));
      unregister();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("loads pi-telegram in RPC mode with a persistent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      logger,
    });

    try {
      expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
      expect(host.runtime.session.sessionFile).toContain(
        join(root, "state", "sessions"),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Telegram is not configured"),
      );
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("opens the durable inbox under stateDir, registers it, and releases it on dispose", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-inbox-"));
    const extensionPath = join(root, "noop-extension.mjs");
    await writeFile(extensionPath, `export default function() {}\n`);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const close = vi.fn();
    const fakeInbox = {
      persist: vi.fn(),
      remove: vi.fn(),
      loadPending: vi.fn(() => []),
      close,
    };
    const openInbox = vi.fn(() => fakeInbox);
    const unbindInbox = vi.fn();
    const bindInbox = vi.fn(() => unbindInbox);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      logger,
      telegramExtensionPath: extensionPath,
      openInbox,
      bindInbox,
    });

    try {
      expect(openInbox).toHaveBeenCalledWith(join(root, "state", "inbox.db"));
      expect(bindInbox).toHaveBeenCalledWith(fakeInbox);
      expect(unbindInbox).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }

    expect(unbindInbox).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("round-trips a real turn: host SQLite inbox ↔ pinned fork reconcile/replay", async () => {
    const { bindTelegramInboundInbox } = await import(
      "../src/telegram-capabilities.js"
    );
    const { openInbox } = await import("../src/inbox.js");
    const inboxModulePath = join(
      dirname(resolveTelegramExtensionPath()),
      "lib",
      "inbox.ts",
    );
    const queueModulePath = join(
      dirname(resolveTelegramExtensionPath()),
      "lib",
      "queue.ts",
    );
    const forkInbox = (await import(pathToFileURL(inboxModulePath).href)) as {
      getTelegramInboundInbox: () => unknown;
      withTelegramInboundInboxPersistence: (store: unknown) => {
        getQueuedItems: () => unknown[];
        setQueuedItems: (items: unknown[]) => void;
      };
      replayTelegramInboundInbox: (store: unknown, inbox: unknown) => number;
    };
    const forkQueue = (await import(pathToFileURL(queueModulePath).href)) as {
      createTelegramQueueStore: () => unknown;
    };

    const root = await mkdtemp(join(tmpdir(), "pi-telegram-inbox-e2e-"));
    const inbox = openInbox(join(root, "inbox.db"));
    const unbind = bindTelegramInboundInbox(inbox);

    const turn = {
      kind: "prompt",
      chatId: 7,
      replyToMessageId: 10,
      queueOrder: 0,
      queueLane: "default",
      laneOrder: 0,
      statusSummary: "hi",
      sourceMessageIds: [10],
      queuedAttachments: [],
      content: [{ type: "text", text: "remember the milk" }],
      historyText: "hi",
    };

    try {
      // The host's bind and the fork's read rendezvous on the shared symbol.
      expect(forkInbox.getTelegramInboundInbox()).toBe(inbox);

      // Fork wraps its queue store; accepting a turn persists it to real SQLite.
      const store = forkInbox.withTelegramInboundInboxPersistence(
        forkQueue.createTelegramQueueStore(),
      );
      store.setQueuedItems([turn]);
      expect(inbox.loadPending()).toEqual([
        { id: "7:10", payload: JSON.stringify(turn) },
      ]);

      // Simulate a restart: a fresh queue store replays the durable turn.
      const restartedStore = forkInbox.withTelegramInboundInboxPersistence(
        forkQueue.createTelegramQueueStore(),
      );
      expect(
        forkInbox.replayTelegramInboundInbox(restartedStore, inbox),
      ).toBe(1);
      expect(restartedStore.getQueuedItems()).toEqual([turn]);

      // Dispatch (turn leaves the queue) clears the durable record.
      restartedStore.setQueuedItems([]);
      expect(inbox.loadPending()).toEqual([]);
    } finally {
      unbind();
      inbox.close();
    }
  }, 20_000);

  it("ignores extensions and skills discovered outside the bridge repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-global-filter-"));
    // Mirror production: the agent dir is not inside the bridge repo cwd.
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const extensionPath = join(cwd, "telegram-extension.mjs");
    await mkdir(cwd, { recursive: true });
    await writeFile(extensionPath, "export default function() {}\n");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "global-extension.js"),
      "export default function() {}\n",
    );
    await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
    await writeFile(
      join(agentDir, "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: must not load\n---\nbody\n",
    );
    // A repo-local extension must survive the filter.
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "local-extension.js"),
      "export default function() {}\n",
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir,
        cwd,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      expect(logger.warn).toHaveBeenCalledWith(
        `Ignoring non-repo extension: ${join(agentDir, "extensions", "global-extension.js")}`,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring non-repo skill: global-skill"),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("local-extension"),
      );
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);
});
