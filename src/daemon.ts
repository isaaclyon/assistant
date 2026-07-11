import { resolveBridgeConfig } from "./config.js";
import { startBridgeHost } from "./host.js";
import {
  bindProcessShutdownSignals,
  createShutdownLatch,
  waitForShutdown,
} from "./lifecycle.js";

const latch = createShutdownLatch((reason) => {
  console.log(`Shutdown requested (${reason}).`);
});
const unbindSignals = bindProcessShutdownSignals(latch);

try {
  const host = await startBridgeHost({
    config: resolveBridgeConfig(),
    onShutdownRequest: () => latch.request("extension"),
  });
  await waitForShutdown(latch);
  await host.dispose();
  console.log("Pi Telegram bridge stopped cleanly.");
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Pi Telegram bridge failed: ${message}`);
  process.exitCode = 1;
} finally {
  unbindSignals();
}
