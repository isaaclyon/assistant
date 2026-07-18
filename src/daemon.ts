import { resolveBridgeConfig } from "./config.js";
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

const config = resolveBridgeConfig();

const latch = createShutdownLatch((reason) => {
  console.log(`Shutdown requested (${reason}).`);
});
const unbindSignals = bindProcessShutdownSignals(latch);
// Keeps the event loop alive while the daemon idles between signals.
const keepAlive = setInterval(() => {}, 60_000);

try {
  const host = await startBridgeHost({
    config,
    onShutdownRequest: () => latch.request("extension"),
    onRestartRequest: () => {
      try {
        markRestartPending(config.stateDir);
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
  const reason = await latch.wait();
  const exitCode = restartExitCode(reason);
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
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Pi Telegram bridge failed: ${message}`);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
  unbindSignals();
}
