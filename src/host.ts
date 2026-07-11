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
import { join } from "node:path";

import {
  type BridgeConfig,
  hasConfiguredTelegramToken,
  isProcessAlive,
  readDefaultTelegramLock,
  shouldRecoverTelegramOwnership,
} from "./config.js";
import { resolveTelegramExtensionPath } from "./package-paths.js";
import { bindTelegramHostNewSession } from "./telegram-host-capability.js";

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
}: BridgeHostOptions): Promise<BridgeHost> {
  process.env.PI_CODING_AGENT_DIR = config.agentDir;
  initTheme();
  await mkdir(config.sessionDir, { recursive: true, mode: 0o700 });

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: [telegramExtensionPath],
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
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: config.cwd,
    agentDir: config.agentDir,
    sessionManager: SessionManager.continueRecent(config.cwd, config.sessionDir),
  });

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
    throw error;
  }

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
    unregisterTelegramHost();
    await runtime.dispose();
    throw error;
  }

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
  let recoveringOwnership = false;
  const recoverOwnership = async (): Promise<void> => {
    if (recoveringOwnership) return;
    const lock = await readDefaultTelegramLock(locksPath);
    if (!shouldRecoverTelegramOwnership(lock, process.pid)) return;
    recoveringOwnership = true;
    logger.info("Telegram has no live polling owner; connecting the default profile.");
    try {
      await runtime.session.prompt("/telegram-connect", { source: "rpc" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Telegram connect command failed: ${message}`);
    } finally {
      recoveringOwnership = false;
    }
  };

  let ownershipMonitor: ReturnType<typeof setInterval> | undefined;
  if (!telegramConfigured) {
    logger.warn(
      "Telegram is not configured. Run `npm run telegram:setup`, then restart this service.",
    );
  } else {
    const lock = await readDefaultTelegramLock(locksPath);
    if (lock?.pid === process.pid) {
      logger.info("This service owns Telegram polling.");
    } else if (lock && isProcessAlive(lock.pid)) {
      logger.warn(
        `Telegram polling is currently owned by another live Pi process (PID ${lock.pid}); waiting to recover it when that process exits.`,
      );
    } else if (lock) {
      logger.info("A stale Telegram ownership lock exists; pi-telegram will reclaim it.");
    } else {
      await recoverOwnership();
    }

    ownershipMonitor = setInterval(() => {
      void recoverOwnership();
    }, 5_000);
    ownershipMonitor.unref?.();
  }

  logger.info(`Pi Telegram bridge ready (session: ${runtime.session.sessionFile ?? "ephemeral"}).`);

  return {
    runtime,
    async dispose() {
      if (ownershipMonitor) clearInterval(ownershipMonitor);
      try {
        await runtime.dispose();
      } finally {
        unregisterTelegramHost();
      }
    },
  };
}
