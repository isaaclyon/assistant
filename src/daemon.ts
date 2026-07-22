import { loadBridgeRuntimeConfig } from "./config.js";
import { startBridgeHost } from "./host.js";
import {
  awaitShutdownDisposal,
  bindProcessShutdownSignals,
  createShutdownLatch,
  restartExitCode,
} from "./lifecycle.js";
import {
  markRestartPending,
  notifyPendingRestart,
} from "./restart-notification.js";
import {
  createRuntimeMetadata,
  type BridgeRuntimeStatus,
  writeRuntimeMetadata,
} from "./runtime-metadata.js";

const config = await loadBridgeRuntimeConfig();

const latch = createShutdownLatch((reason) => {
  console.log(`Shutdown requested (${reason}).`);
});
const unbindSignals = bindProcessShutdownSignals(latch);
// Keeps the event loop alive while the daemon idles between signals.
const keepAlive = setInterval(() => {}, 60_000);

const writeInstanceRuntimeStatus = async (
  status: BridgeRuntimeStatus,
  sessionFile?: string,
): Promise<void> => {
  if (!("instanceId" in config)) return;
  const releaseSha = process.env.PI_TELEGRAM_BRIDGE_RELEASE_SHA?.trim() ?? "";
  await writeRuntimeMetadata(
    config.runtimeMetadataPath,
    createRuntimeMetadata({
      instanceId: config.instanceId,
      releaseSha,
      pid: process.pid,
      status,
      principal: config.principal,
      telegramSurface: config.telegramSurface.type,
      workspaceCwd: config.workspaceCwd,
      resourceRoot: config.resourceRoot,
      ...(sessionFile ? { sessionFile } : {}),
    }),
  );
};

try {
  await writeInstanceRuntimeStatus("starting");
  const host = await startBridgeHost({
    config,
    onShutdownRequest: () => latch.request("extension"),
    onRestartRequest: () => {
      try {
        markRestartPending(
          config.stateDir,
          "instanceId" in config
            ? {
                instanceId: config.instanceId,
                telegramProfile: config.telegramProfile,
              }
            : undefined,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Could not persist restart confirmation: ${message}`);
      }
      latch.request("restart");
    },
  });
  try {
    if (await notifyPendingRestart(config)) {
      console.log("Sent restart confirmation to Telegram.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not send restart confirmation: ${message}`);
  }
  await writeInstanceRuntimeStatus("ready", host.runtime.session.sessionFile);
  const reason = await latch.wait();
  const exitCode = restartExitCode(reason);
  await writeInstanceRuntimeStatus("stopping", host.runtime.session.sessionFile);
  const disposalResult = await awaitShutdownDisposal(() => host.dispose());
  if (disposalResult === "timed-out") {
    console.error(
      "Graceful bridge shutdown timed out; forcing process exit so the service supervisor can recover.",
    );
    process.exit(exitCode);
  }
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    console.log("Restart requested; exiting non-zero so systemd restarts the bridge.");
  } else {
    console.log("Pi Telegram bridge stopped cleanly.");
  }
} catch (error) {
  try {
    await writeInstanceRuntimeStatus("failed");
  } catch (metadataError) {
    const metadataMessage =
      metadataError instanceof Error ? metadataError.message : String(metadataError);
    console.error(`Could not record failed runtime readiness: ${metadataMessage}`);
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Pi Telegram bridge failed: ${message}`);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
  unbindSignals();
}
