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

  const bindSession = async (session: AgentSession): Promise<void> => {
    await session.bindExtensions({
      mode: "rpc",
      shutdownHandler: () => {
        void session.waitForIdle().then(onShutdownRequest);
      },
      onError: (error) => {
        logger.error(
          `Extension error in ${error.extensionPath} (${error.event}): ${error.error}`,
        );
      },
    });
  };
  runtime.setRebindSession(bindSession);
  await bindSession(runtime.session);

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
      await runtime.dispose();
    },
  };
}
