import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  DefaultPackageManager,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import {
  type BridgeConfig,
  type TelegramLockView,
  ensureCodexConfig,
  hasConfiguredTelegramToken,
  isProcessAlive as isProcessAliveByPid,
  readDefaultTelegramLock,
  shouldRecoverTelegramOwnership,
} from "./config.js";
import { type InboundInbox, openInbox } from "./inbox.js";
import { type JobScheduler, startJobScheduler } from "./jobs.js";
import {
  resolveCodexExtensionPath,
  resolveTelegramExtensionPath,
} from "./package-paths.js";
import {
  type InboundInboxCapability,
  bindBridgeRestart,
  bindTelegramHostNewSession,
  bindTelegramInboundInbox,
} from "./telegram-capabilities.js";

/**
 * Publishes the durable inbox on the shared registry the pinned fork reads, and
 * returns an unbind callback. Injectable so tests can substitute a fake binding.
 */
export type BindInbox = (inbox: InboundInboxCapability) => () => void;

export interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface BridgeHostOptions {
  config: BridgeConfig;
  logger?: BridgeLogger;
  onShutdownRequest?: () => void;
  onRestartRequest?: () => void;
  telegramExtensionPath?: string;
  isProcessAlive?: (pid: number) => boolean;
  nowMs?: () => number;
  ownershipMonitorIntervalMs?: number;
  readTelegramLock?: (path: string) => Promise<TelegramLockView | undefined>;
  openInbox?: (dbPath: string) => InboundInbox;
  bindInbox?: BindInbox;
}

export interface BridgeHost {
  runtime: AgentSessionRuntime;
  dispose(): Promise<void>;
}

const consoleLogger: BridgeLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export async function startBridgeHost({
  config,
  logger = consoleLogger,
  onShutdownRequest = () => {},
  onRestartRequest = () => {},
  telegramExtensionPath = resolveTelegramExtensionPath(),
  isProcessAlive = isProcessAliveByPid,
  nowMs = Date.now,
  ownershipMonitorIntervalMs = 5_000,
  readTelegramLock = readDefaultTelegramLock,
  openInbox: openInboxStore = openInbox,
  bindInbox = bindTelegramInboundInbox,
}: BridgeHostOptions): Promise<BridgeHost> {
  const codexExtensionPath = resolveCodexExtensionPath();
  process.env.PI_CODING_AGENT_DIR = config.agentDir;
  process.env.PI_CODEX_CONVERSION_CONFIG_PATH = config.codexConfigPath;
  initTheme();
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(config.sessionDir, { recursive: true, mode: 0o700 });
  await ensureCodexConfig(config.codexConfigPath);

  const telegramAgentsPath = join(config.cwd, ".pi", "telegram", "AGENTS.md");
  const bridgeRealPath = await realpath(config.cwd);
  const bridgeRealPrefix = bridgeRealPath + sep;
  const isInsideBridge = (target: string): boolean =>
    target === bridgeRealPath || target.startsWith(bridgeRealPrefix);
  let lastTelegramAgentsContent: string | undefined;
  const loadTelegramAgentsContent = (): string => {
    try {
      const target = realpathSync(telegramAgentsPath);
      if (!isInsideBridge(target)) {
        throw new Error(
          `Telegram instructions resolve outside the bridge repository: ${telegramAgentsPath}`,
        );
      }
      const content = readFileSync(target, "utf8");
      lastTelegramAgentsContent = content;
      return content;
    } catch (error) {
      if (lastTelegramAgentsContent === undefined) throw error;
      logger.warn(
        `Could not reload Telegram instructions from ${telegramAgentsPath}; keeping the last loaded version.`,
      );
      return lastTelegramAgentsContent;
    }
  };

  const resourceManager = new DefaultPackageManager({
    cwd: config.cwd,
    agentDir: config.agentDir,
    settingsManager: SettingsManager.create(config.cwd, config.agentDir),
  });
  const discoverRepoResources = async (): Promise<{
    extensions: string[];
    skills: string[];
  }> => {
    const resolved = await resourceManager.resolveExtensionSources(
      [join(config.cwd, ".pi")],
      { temporary: true },
    );
    const keepInsideBridge = async (
      path: string,
      kind: "extension" | "skill",
    ): Promise<boolean> => {
      try {
        const target = await realpath(path);
        if (isInsideBridge(target)) {
          return true;
        }
      } catch {
        // Missing or unreadable resources are excluded before Pi can load them.
      }
      logger.warn(`Ignoring non-repo ${kind}: ${path}`);
      return false;
    };
    const extensions: string[] = [];
    for (const resource of resolved.extensions) {
      if (resource.enabled && (await keepInsideBridge(resource.path, "extension"))) {
        extensions.push(resource.path);
      }
    }
    const skills: string[] = [];
    for (const resource of resolved.skills) {
      if (resource.enabled && (await keepInsideBridge(resource.path, "skill"))) {
        skills.push(resource.path);
      }
    }
    return { extensions, skills };
  };
  let refreshRuntimeResources: () => Promise<void> = async () => {};

  // Open and register the durable inbox before the runtime starts its session:
  // the fork replays pending turns on session start, so the capability must be
  // live first. A registration failure must still release the database handle.
  const inbox = openInboxStore(join(config.stateDir, "inbox.db"));
  let unregisterInbox: () => void;
  try {
    unregisterInbox = bindInbox(inbox);
  } catch (error) {
    inbox.close();
    throw error;
  }

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    // ADR-0009: the always-on bridge loads one explicit runtime instruction
    // file instead of inheriting developer or server-level AGENTS.md files.
    // Resolve and canonicalize repo resources before Pi imports any extension.
    // Post-load filtering is too late because extension modules and factories
    // execute during loading.
    const additionalExtensionPaths = [telegramExtensionPath, codexExtensionPath];
    const additionalSkillPaths: string[] = [];
    const refreshRepoResources = async (): Promise<void> => {
      const discovered = await discoverRepoResources();
      additionalExtensionPaths.splice(
        2,
        additionalExtensionPaths.length - 2,
        ...discovered.extensions,
      );
      additionalSkillPaths.splice(0, additionalSkillPaths.length, ...discovered.skills);
    };
    await refreshRepoResources();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths,
        additionalSkillPaths,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        agentsFilesOverride: () => ({
          agentsFiles: [
            { path: telegramAgentsPath, content: loadTelegramAgentsContent() },
          ],
        }),
      },
    });
    refreshRuntimeResources = refreshRepoResources;
    const extensions = services.resourceLoader.getExtensions();
    const telegramLoaded = extensions.extensions.some(
      (extension) =>
        extension.path === telegramExtensionPath ||
        extension.resolvedPath === telegramExtensionPath,
    );
    if (!telegramLoaded) {
      const loadError = extensions.errors.find(
        (error) => error.path === telegramExtensionPath,
      );
      throw new Error(
        `Telegram extension failed to load from ${telegramExtensionPath}${loadError ? `: ${loadError.error}` : ""}`,
      );
    }
    const codexLoaded = extensions.extensions.some(
      (extension) =>
        extension.path === codexExtensionPath ||
        extension.resolvedPath === codexExtensionPath,
    );
    if (!codexLoaded) {
      const loadError = extensions.errors.find(
        (error) => error.path === codexExtensionPath,
      );
      throw new Error(
        `Codex conversion extension failed to load from ${codexExtensionPath}${loadError ? `: ${loadError.error}` : ""}`,
      );
    }
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  let runtime: AgentSessionRuntime;
  try {
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: config.cwd,
      agentDir: config.agentDir,
      sessionManager: SessionManager.continueRecent(config.cwd, config.sessionDir),
    });
  } catch (error) {
    unregisterInbox();
    inbox.close();
    throw error;
  }

  // Publish the restart trigger for the repo-local /restart command. Deferring
  // to waitForIdle mirrors the shutdownHandler below so disposal never races an
  // in-flight turn; the daemon exits non-zero on this reason so systemd restarts.
  let unbindRestart: () => void;
  try {
    unbindRestart = bindBridgeRestart(() => {
      void runtime.session.waitForIdle().then(onRestartRequest);
    });
  } catch (error) {
    await runtime.dispose();
    unregisterInbox();
    inbox.close();
    throw error;
  }

  let sessionReplacementInFlight = false;
  let unregisterTelegramHost: () => void;
  try {
    unregisterTelegramHost = bindTelegramHostNewSession(async () => {
      if (sessionReplacementInFlight) {
        throw new Error("A Pi session replacement is already in progress.");
      }
      if (!runtime.session.isIdle) {
        throw new Error("Pi became busy before session replacement could start.");
      }
      sessionReplacementInFlight = true;
      try {
        return await runtime.newSession();
      } finally {
        sessionReplacementInFlight = false;
      }
    });
  } catch (error) {
    await runtime.dispose();
    unbindRestart();
    unregisterInbox();
    inbox.close();
    throw error;
  }

  let ownershipMonitor: ReturnType<typeof setInterval> | undefined;
  let ownershipRecoveryPromise: Promise<void> | undefined;
  let jobScheduler: JobScheduler | undefined;
  let stopping = false;
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      stopping = true;
      if (ownershipMonitor) clearInterval(ownershipMonitor);
      try {
        await jobScheduler?.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Job scheduler shutdown failed: ${message}`);
      }
      try {
        await ownershipRecoveryPromise;
      } catch {
        // Startup rethrows this error and monitor callbacks log it. Disposal
        // must still release Pi and the process-local host capability.
      }
      try {
        await runtime.dispose();
      } finally {
        unregisterTelegramHost();
        unbindRestart();
        unregisterInbox();
        inbox.close();
      }
    })();
    return disposePromise;
  };

  const bindSession = async (session: AgentSession): Promise<void> => {
    await session.bindExtensions({
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: async (entryId, options) => {
          const result = await runtime.fork(entryId, options);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await runtime.session.navigateTree(targetId, {
            ...(options?.summarize === undefined ? {} : { summarize: options.summarize }),
            ...(options?.customInstructions === undefined
              ? {}
              : { customInstructions: options.customInstructions }),
            ...(options?.replaceInstructions === undefined
              ? {}
              : { replaceInstructions: options.replaceInstructions }),
            ...(options?.label === undefined ? {} : { label: options.label }),
          });
          return { cancelled: result.cancelled };
        },
        switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: async () => {
          await refreshRuntimeResources();
          await runtime.session.reload();
        },
      },
      shutdownHandler: () => {
        void runtime.session.waitForIdle().then(onShutdownRequest);
      },
      onError: (error) => {
        logger.error(
          `Extension error in ${error.extensionPath} (${error.event}): ${error.error}`,
        );
      },
    });
  };
  runtime.setRebindSession(bindSession);
  try {
    await bindSession(runtime.session);
  } catch (error) {
    await dispose();
    throw error;
  }

  try {
    for (const diagnostic of runtime.diagnostics) {
      const render = `${diagnostic.type}: ${diagnostic.message}`;
      if (diagnostic.type === "error") logger.error(render);
      else if (diagnostic.type === "warning") logger.warn(render);
      else logger.info(render);
    }
    if (runtime.modelFallbackMessage) logger.warn(runtime.modelFallbackMessage);

    const telegramConfigPath = join(config.agentDir, "telegram.json");
    const locksPath = join(config.agentDir, "locks.json");
    const telegramConfigured = await hasConfiguredTelegramToken(telegramConfigPath);
    const recoverOwnership = (): Promise<void> => {
      if (stopping) return Promise.resolve();
      if (ownershipRecoveryPromise) return ownershipRecoveryPromise;
      const recovery = (async () => {
        const lock = await readTelegramLock(locksPath);
        if (stopping) return;
        if (
          !shouldRecoverTelegramOwnership(
            lock,
            process.pid,
            isProcessAlive,
            nowMs(),
          )
        ) {
          return;
        }
        logger.info("Telegram has no live polling owner; connecting the default profile.");
        try {
          await runtime.session.prompt("/telegram-connect", { source: "rpc" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Telegram connect command failed: ${message}`);
        }
      })();
      const trackedRecovery = recovery.finally(() => {
        if (ownershipRecoveryPromise === trackedRecovery) {
          ownershipRecoveryPromise = undefined;
        }
      });
      ownershipRecoveryPromise = trackedRecovery;
      return trackedRecovery;
    };

    if (!telegramConfigured) {
      logger.warn(
        "Telegram is not configured. Run `npm run telegram:setup`, then restart this service.",
      );
    } else {
      const lock = await readTelegramLock(locksPath);
      const shouldRecover = shouldRecoverTelegramOwnership(
        lock,
        process.pid,
        isProcessAlive,
        nowMs(),
      );
      if (lock && !shouldRecover) {
        if (lock.pid === process.pid) {
          logger.info("This service owns Telegram polling.");
        } else {
          logger.warn(
            `Telegram polling is currently owned by another live Pi process (PID ${lock.pid}); waiting to recover it when that process exits.`,
          );
        }
      } else {
        if (lock) {
          logger.info("A stale Telegram ownership lock exists; reclaiming it.");
        }
        await recoverOwnership();
      }

      ownershipMonitor = setInterval(() => {
        void recoverOwnership().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Telegram ownership check failed: ${message}`);
        });
      }, ownershipMonitorIntervalMs);
      ownershipMonitor.unref?.();
    }

    // Scheduled jobs and webhook triggers inject prompts through the same RPC
    // seam as /telegram-connect above; the fork's proactive push delivers the
    // final reply to the paired chat because these turns have no Telegram turn.
    const injectJobPrompt = async (prompt: string): Promise<void> => {
      for (let attempt = 1; ; attempt += 1) {
        await runtime.session.waitForIdle();
        try {
          await runtime.session.prompt(prompt, { source: "rpc" });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 5 || !message.includes("already processing")) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
        }
      }
    };
    jobScheduler = await startJobScheduler({
      stateDir: config.stateDir,
      webhookHost: config.webhookHost,
      webhookPort: config.webhookPort,
      inject: injectJobPrompt,
      logger,
    });

    logger.info(`Pi Telegram bridge ready (session: ${runtime.session.sessionFile ?? "ephemeral"}).`);

    return { runtime, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
