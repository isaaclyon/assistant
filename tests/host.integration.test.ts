import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  TELEGRAM_LOCK_STALE_HEARTBEAT_MS,
  resolveBridgeInstanceConfig,
} from "../src/config.js";
import { startBridgeHost } from "../src/host.js";
import { parseBridgeInstanceManifest } from "../src/instances.js";
import { enqueueJobHandoff } from "../src/job-handoff.js";
import { bindTelegramHostHouseholdGroup } from "../src/telegram-capabilities.js";
import {
  resolveRetryExtensionPath,
  resolveTelegramExtensionPath,
} from "../src/package-paths.js";

const BRIDGE_RUNTIME_REGISTRY = Symbol.for(
  "pi-telegram-bridge.runtime-registry",
);
const TELEGRAM_HOST_REGISTRY = Symbol.for(
  "pi-telegram.host-capability-registry",
);

async function startTestBridgeHost(
  options: Parameters<typeof startBridgeHost>[0],
): ReturnType<typeof startBridgeHost> {
  const resourceRoot =
    "resourceRoot" in options.config
      ? options.config.resourceRoot
      : options.config.cwd;
  const agentsPath = join(
    resourceRoot,
    ".pi",
    "telegram",
    "AGENTS.md",
  );
  await mkdir(dirname(agentsPath), { recursive: true });
  try {
    await writeFile(agentsPath, "test Telegram guidance\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return startBridgeHost(options);
}

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

async function loadPinnedTelegramHostHouseholdInternals(): Promise<{
  getTelegramHostHouseholdGroup(): {
    kind: "household-group";
    chatId: number;
    actors: readonly { userId: number; label: string }[];
  } | undefined;
  isTelegramHostPrivateChatThreadedModeAllowed(): boolean;
}> {
  const path = join(dirname(resolveTelegramExtensionPath()), "lib", "host.ts");
  return (await import(pathToFileURL(path).href)) as Awaited<
    ReturnType<typeof loadPinnedTelegramHostHouseholdInternals>
  >;
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
  it("rejects malformed idle-session state before touching the durable inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-idle-state-"));
    const stateDir = join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "conversation-session-state.json"),
      '{"version":1,"lastHumanPromptAt":"invalid"}\n',
      { mode: 0o600 },
    );
    const openInbox = vi.fn();

    await expect(
      startTestBridgeHost({
        config: {
          agentDir: join(root, "agent"),
          cwd: root,
          sessionDir: join(stateDir, "sessions"),
          stateDir,
          codexConfigPath: join(stateDir, "pi-codex-conversion.json"),
          sessionIdleMs: 8 * 60 * 60_000,
          webhookHost: "127.0.0.1",
          webhookPort: 0,
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        openInbox,
      }),
    ).rejects.toThrow(/conversation session state.*lastHumanPromptAt/i);
    expect(openInbox).not.toHaveBeenCalled();
  });

  it("shares the exact household authorization policy with the pinned fork", async () => {
    const pinnedHost = await loadPinnedTelegramHostHouseholdInternals();
    const policy = {
      kind: "household-group" as const,
      chatId: -100123,
      actors: [
        { userId: 101, label: "Isaac" as const },
        { userId: 202, label: "Emma" as const },
      ],
    } as const;

    const unbind = bindTelegramHostHouseholdGroup(policy);
    try {
      expect(pinnedHost.getTelegramHostHouseholdGroup()).toEqual(policy);
      expect(pinnedHost.isTelegramHostPrivateChatThreadedModeAllowed()).toBe(
        false,
      );
    } finally {
      unbind();
    }
    expect(pinnedHost.getTelegramHostHouseholdGroup()).toBeUndefined();
    expect(pinnedHost.isTelegramHostPrivateChatThreadedModeAllowed()).toBe(true);
  });

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
          // Keep the fake credential safely outside refresh windows even when
          // the full suite is slow; replacement must not attempt OAuth I/O.
          expires: Date.now() + 60 * 60_000,
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
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      expect(
        (globalThis as Record<PropertyKey, unknown>)[BRIDGE_RUNTIME_REGISTRY],
      ).toMatchObject({ version: 1, runtime: {} });
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
      }, { timeout: 30_000 });
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
    expect(
      (globalThis as Record<PropertyKey, unknown>)[BRIDGE_RUNTIME_REGISTRY],
    ).toEqual({ version: 1 });
    const unregister = registerTelegramHostNewSession(async () => ({ cancelled: false }));
    unregister();
  }, 40_000);

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
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
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
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
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
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
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
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
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
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
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
        startTestBridgeHost({
          config: {
            agentDir,
            cwd: root,
            sessionDir: join(root, "state", "sessions"),
            stateDir: join(root, "state"),
            codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
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
    const host = await startTestBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger,
    });

    try {
      expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
      expect(host.runtime.session.sessionFile).toContain(
        join(root, "state", "sessions"),
      );
      expect(
        (globalThis as Record<PropertyKey, unknown>)[TELEGRAM_HOST_REGISTRY],
      ).toMatchObject({ replacementGuard: expect.any(Function) });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Telegram is not configured"),
      );
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    expect(
      (globalThis as Record<PropertyKey, unknown>)[TELEGRAM_HOST_REGISTRY],
    ).not.toHaveProperty("replacementGuard");
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
    const host = await startTestBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
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

  it("does not execute extensions or load skills outside the bridge repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-global-filter-"));
    // Mirror production: the agent dir is not inside the bridge repo cwd.
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const extensionPath = join(cwd, "telegram-extension.mjs");
    const sideEffectMarker = join(root, "global-extension-executed");
    await mkdir(cwd, { recursive: true });
    await writeFile(extensionPath, "export default function() {}\n");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "global-extension.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sideEffectMarker)}, "executed");\nexport default function() {}\n`,
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
    await mkdir(join(cwd, ".pi", "skills", "local-skill"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "skills", "local-skill", "SKILL.md"),
      "---\nname: local-skill\ndescription: must load\n---\nbody\n",
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      await expect(readFile(sideEffectMarker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        host.runtime.services.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.resolvedPath),
      ).toContain(join(cwd, ".pi", "extensions", "local-extension.js"));
      expect(
        host.runtime.services.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.resolvedPath),
      ).toContain(resolveRetryExtensionPath());
      expect(
        host.runtime.services.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.resolvedPath),
      ).not.toContain(join(agentDir, "extensions", "global-extension.js"));
      expect(
        host.runtime.services.resourceLoader
          .getSkills()
          .skills.map((skill) => skill.name),
      ).toEqual(["local-skill"]);
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("loads resources only from the immutable release while executing in the instance workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-root-split-"));
    const resourceRoot = join(root, "release");
    const workspaceCwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const telegramExtensionPath = join(resourceRoot, "telegram-extension.mjs");
    const connectedProfilePath = join(root, "connected-profile.txt");
    const handoffMarkerPath = join(root, "handoff-executed.txt");
    await mkdir(join(resourceRoot, ".pi", "extensions"), { recursive: true });
    await mkdir(join(resourceRoot, ".pi", "skills", "release-skill"), {
      recursive: true,
    });
    await mkdir(join(resourceRoot, ".pi", "skills", "unselected-skill"), {
      recursive: true,
    });
    await mkdir(join(resourceRoot, ".pi", "telegram"), { recursive: true });
    await mkdir(join(workspaceCwd, ".pi", "extensions"), { recursive: true });
    await mkdir(join(workspaceCwd, ".pi", "skills", "workspace-skill"), {
      recursive: true,
    });
    await mkdir(join(workspaceCwd, ".pi", "telegram"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "telegram.json"),
      JSON.stringify({ profiles: { isaac: { botToken: "test-token" } } }),
      { mode: 0o600 },
    );
    await writeFile(
      telegramExtensionPath,
      `import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.registerCommand("telegram-connect", {
    description: "test named profile activation",
    handler: async (args) => writeFileSync(${JSON.stringify(connectedProfilePath)}, args),
  });
  pi.registerCommand("handoff-test", {
    description: "test durable target handoff",
    handler: async (args) => writeFileSync(${JSON.stringify(handoffMarkerPath)}, args),
  });
}
`,
    );
    await writeFile(
      join(resourceRoot, ".pi", "extensions", "release-extension.js"),
      "export default function() {}\n",
    );
    await writeFile(
      join(resourceRoot, ".pi", "extensions", "unselected-extension.js"),
      "export default function() {}\n",
    );
    await writeFile(
      join(resourceRoot, ".pi", "skills", "release-skill", "SKILL.md"),
      "---\nname: release-skill\ndescription: release only\n---\nbody\n",
    );
    await writeFile(
      join(resourceRoot, ".pi", "skills", "unselected-skill", "SKILL.md"),
      "---\nname: unselected-skill\ndescription: must stay hidden\n---\nbody\n",
    );
    await writeFile(
      join(resourceRoot, ".pi", "telegram", "AGENTS.md"),
      "release guidance\n",
    );
    await writeFile(
      join(resourceRoot, ".pi", "capabilities.json"),
      JSON.stringify({
        version: 1,
        resources: {
          extensions: [
            {
              id: "release-extension",
              path: ".pi/extensions/release-extension.js",
              enabled: true,
            },
            {
              id: "unselected-extension",
              path: ".pi/extensions/unselected-extension.js",
              enabled: true,
            },
          ],
          skills: [
            {
              id: "release-skill",
              path: ".pi/skills/release-skill/SKILL.md",
              enabled: true,
            },
            {
              id: "unselected-skill",
              path: ".pi/skills/unselected-skill/SKILL.md",
              enabled: true,
            },
          ],
          instructions: [
            {
              id: "telegram-default",
              path: ".pi/telegram/AGENTS.md",
              enabled: true,
            },
          ],
        },
        profiles: [
          {
            id: "personal-isaac",
            extensions: ["release-extension"],
            skills: ["release-skill"],
            instructions: "telegram-default",
          },
        ],
      }),
    );
    await writeFile(
      join(workspaceCwd, ".pi", "extensions", "workspace-extension.js"),
      "export default function() {}\n",
    );
    await writeFile(
      join(workspaceCwd, ".pi", "skills", "workspace-skill", "SKILL.md"),
      "---\nname: workspace-skill\ndescription: must stay hidden\n---\nbody\n",
    );
    await writeFile(
      join(workspaceCwd, ".pi", "telegram", "AGENTS.md"),
      "workspace guidance must stay hidden\n",
    );

    const manifest = parseBridgeInstanceManifest(
      JSON.stringify({
        version: 1,
        instances: [
          {
            id: "isaac",
            displayName: "Isaac Bot",
            principal: "isaac",
            telegramProfile: "isaac",
            telegramSurface: { type: "private" },
            workspaceCwd,
            capabilityProfile: "personal-isaac",
            credentialScope: "isaac-personal",
            memoryView: "owner-and-household",
            jobsRole: "coordinator",
          },
        ],
      }),
    );
    const config = resolveBridgeInstanceConfig(
      manifest,
      "isaac",
      {
        PI_CODING_AGENT_DIR: agentDir,
        PI_TELEGRAM_BRIDGE_STATE_ROOT: join(root, "state"),
        PI_TELEGRAM_BRIDGE_CONFIG_ROOT: join(root, "config"),
      },
      root,
      resourceRoot,
    );
    const canonicalResourceRoot = await realpath(resourceRoot);
    // This is a current-protocol startup fixture, not a legacy migration.
    const { openJobOccurrenceLedger } = await import("../src/job-occurrences.js");
    const ledger = openJobOccurrenceLedger(config.stateDir);
    ledger.reconcileDefinitions([], {});
    ledger.close();
    await enqueueJobHandoff({
      stateRoot: config.stateRoot,
      coordinatorStateDir: config.stateDir,
      eventId: "test:host-startup-handoff",
      definitionFingerprint: "a".repeat(64),
      jobId: "host-startup",
      target: "isaac",
      prompt: "/handoff-test routed",
    });

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      telegramExtensionPath,
    });
    try {
      await expect(readFile(connectedProfilePath, "utf8")).resolves.toBe("isaac");
      await vi.waitFor(async () => {
        await expect(readFile(handoffMarkerPath, "utf8")).resolves.toBe("routed");
      });
      expect(host.runtime.session.sessionManager.getCwd()).toBe(workspaceCwd);
      expect(host.runtime.services.resourceLoader.getAgentsFiles()).toEqual({
        agentsFiles: [
          {
            path: join(canonicalResourceRoot, ".pi", "telegram", "AGENTS.md"),
            content: "release guidance\n",
          },
        ],
      });
      expect(
        host.runtime.services.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.resolvedPath),
      ).toContain(
        join(canonicalResourceRoot, ".pi", "extensions", "release-extension.js"),
      );
      expect(
        host.runtime.services.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.resolvedPath),
      ).not.toContain(join(workspaceCwd, ".pi", "extensions", "workspace-extension.js"));
      expect(
        host.runtime.services.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.resolvedPath),
      ).not.toContain(
        join(
          canonicalResourceRoot,
          ".pi",
          "extensions",
          "unselected-extension.js",
        ),
      );
      expect(
        host.runtime.services.resourceLoader.getSkills().skills.map((skill) => skill.name),
      ).toEqual(["release-skill"]);
      expect(host.runtime.session.sessionFile).toContain(config.sessionDir);
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("rejects repo-local resource symlinks that escape the bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-symlink-filter-"));
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const extensionPath = join(cwd, "telegram-extension.mjs");
    const escapedExtension = join(root, "escaped-extension.js");
    const sideEffectMarker = join(root, "escaped-extension-executed");
    const escapedSkillDir = join(root, "escaped-skill");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills"), { recursive: true });
    await mkdir(escapedSkillDir, { recursive: true });
    await writeFile(extensionPath, "export default function() {}\n");
    await writeFile(
      escapedExtension,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sideEffectMarker)}, "executed");\nexport default function() {}\n`,
    );
    await writeFile(
      join(escapedSkillDir, "SKILL.md"),
      "---\nname: escaped-skill\ndescription: must not load\n---\nbody\n",
    );
    await symlink(escapedExtension, join(cwd, ".pi", "extensions", "escaped.js"));
    await symlink(escapedSkillDir, join(cwd, ".pi", "skills", "escaped"));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      await expect(readFile(sideEffectMarker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(host.runtime.services.resourceLoader.getSkills().skills).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        `Ignoring non-repo extension: ${join(cwd, ".pi", "extensions", "escaped.js")}`,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        `Ignoring non-repo skill: ${join(cwd, ".pi", "skills", "escaped", "SKILL.md")}`,
      );
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("loads only the bridge-specific Telegram agent instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-context-"));
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const extensionPath = join(cwd, "telegram-extension.mjs");
    const telegramAgentsPath = join(cwd, ".pi", "telegram", "AGENTS.md");
    await mkdir(dirname(telegramAgentsPath), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "ancestor guidance\n");
    await writeFile(join(cwd, "AGENTS.md"), "developer guidance\n");
    await writeFile(telegramAgentsPath, "telegram guidance\n");
    await writeFile(extensionPath, "export default function() {}\n");

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startTestBridgeHost({
      config: {
        agentDir,
        cwd,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      telegramExtensionPath: extensionPath,
    });

    try {
      expect(host.runtime.services.resourceLoader.getAgentsFiles()).toEqual({
        agentsFiles: [
          { path: telegramAgentsPath, content: "telegram guidance\n" },
        ],
      });
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("rejects Telegram instructions that resolve outside the bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-context-symlink-"));
    const cwd = join(root, "repo");
    const extensionPath = join(cwd, "telegram-extension.mjs");
    const agentsPath = join(cwd, ".pi", "telegram", "AGENTS.md");
    const externalAgentsPath = join(root, "external-AGENTS.md");
    await mkdir(dirname(agentsPath), { recursive: true });
    await writeFile(extensionPath, "export default function() {}\n");
    await writeFile(externalAgentsPath, "external guidance\n");
    await symlink(externalAgentsPath, agentsPath);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      await expect(
        startBridgeHost({
          config: {
            agentDir: join(root, "agent"),
            cwd,
            sessionDir: join(root, "state", "sessions"),
            stateDir: join(root, "state"),
            codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
          },
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          telegramExtensionPath: extensionPath,
        }),
      ).rejects.toThrow("Telegram instructions resolve outside the bridge repository");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("reloads changed Telegram agent instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-context-reload-"));
    const extensionPath = join(root, "telegram-extension.mjs");
    const agentsPath = join(root, ".pi", "telegram", "AGENTS.md");
    await writeFile(extensionPath, "export default function() {}\n");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startTestBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      telegramExtensionPath: extensionPath,
    });

    try {
      await writeFile(agentsPath, "updated Telegram guidance\n");
      await host.runtime.session.reload();
      expect(host.runtime.services.resourceLoader.getAgentsFiles()).toEqual({
        agentsFiles: [
          { path: agentsPath, content: "updated Telegram guidance\n" },
        ],
      });
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("keeps trusted instructions if reload changes the file to an escaping symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-context-reload-link-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "pi-telegram-host-external-context-"));
    const extensionPath = join(root, "telegram-extension.mjs");
    const agentsPath = join(root, ".pi", "telegram", "AGENTS.md");
    const externalAgentsPath = join(externalRoot, "AGENTS.md");
    await writeFile(extensionPath, "export default function() {}\n");
    await writeFile(externalAgentsPath, "external guidance\n");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startTestBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      await rm(agentsPath);
      await symlink(externalAgentsPath, agentsPath);
      await host.runtime.session.reload();
      expect(host.runtime.services.resourceLoader.getAgentsFiles()).toEqual({
        agentsFiles: [
          { path: agentsPath, content: "test Telegram guidance\n" },
        ],
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("keeping the last loaded version"),
      );
    } finally {
      await host.dispose();
      await rm(externalRoot, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);

  it("keeps the last instructions if the file disappears during replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-context-cache-"));
    const extensionPath = join(root, "telegram-extension.mjs");
    const agentsPath = join(root, ".pi", "telegram", "AGENTS.md");
    await writeFile(extensionPath, "export default function() {}\n");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startTestBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
        codexConfigPath: join(root, "state", "pi-codex-conversion.json"),
        webhookHost: "127.0.0.1",
        webhookPort: 0,
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      await rm(agentsPath);
      await expect(host.runtime.newSession()).resolves.toEqual({ cancelled: false });
      expect(host.runtime.services.resourceLoader.getAgentsFiles()).toEqual({
        agentsFiles: [
          { path: agentsPath, content: "test Telegram guidance\n" },
        ],
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("keeping the last loaded version"),
      );
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);
});
