import { resolveBridgeConfig } from "./config.js";
import { startBridgeHost } from "./host.js";
import {
  bindProcessShutdownSignals,
  createShutdownLatch,
  restartExitCode,
} from "./lifecycle.js";

const latch = createShutdownLatch((reason) => {
  console.log(`Shutdown requested (${reason}).`);
});
const unbindSignals = bindProcessShutdownSignals(latch);
// Keeps the event loop alive while the daemon idles between signals.
const keepAlive = setInterval(() => {}, 60_000);

try {
  const host = await startBridgeHost({
    config: resolveBridgeConfig(),
    onShutdownRequest: () => latch.request("extension"),
    onRestartRequest: () => latch.request("restart"),
  });
  const reason = await latch.wait();
  await host.dispose();
  const exitCode = restartExitCode(reason);
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
