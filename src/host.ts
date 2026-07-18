import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
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
import {
  resolveCodexExtensionPath,
  resolveTelegramExtensionPath,
} from "./package-paths.js";
import {
  type InboundInboxCapability,
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
    // Only repo-local resources apply to this agent: extensions and skills
    // discovered outside the bridge cwd (~/.pi/agent, ~/.agents, ancestor
    // .agents dirs) are dropped so nothing gains capabilities on this
    // always-on bridge without going through git.
    const repoPrefix = cwd + sep;
    const isRepoLocal = (path: string): boolean =>
      path.startsWith(repoPrefix) ||
      path === telegramExtensionPath ||
      path === codexExtensionPath;
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: [telegramExtensionPath, codexExtensionPath],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) => {
            if (isRepoLocal(extension.resolvedPath)) return true;
            logger.warn(`Ignoring non-repo extension: ${extension.path}`);
            return false;
          }),
        }),
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) => {
            if (isRepoLocal(skill.filePath)) return true;
            logger.warn(`Ignoring non-repo skill: ${skill.name} (${skill.filePath})`);
            return false;
          }),
        }),
      },
    });
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
    unregisterInbox();
    inbox.close();
    throw error;
  }

  let ownershipMonitor: ReturnType<typeof setInterval> | undefined;
  let ownershipRecoveryPromise: Promise<void> | undefined;
  let stopping = false;
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      stopping = true;
      if (ownershipMonitor) clearInterval(ownershipMonitor);
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
        reload: () => runtime.session.reload(),
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

    logger.info(`Pi Telegram bridge ready (session: ${runtime.session.sessionFile ?? "ephemeral"}).`);

    return { runtime, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
