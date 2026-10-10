import { ApprovedCredentialBroker } from "./approved-credential-broker.js";
import { ApprovedLoginVault } from "./approved-login-vault.js";
import { loadTrustedBrokerConfig } from "./trusted-broker-config.js";
import { serveTrustedTelegram } from "./trusted-telegram-ipc.js";
import { TrustedTelegramStore } from "./trusted-telegram-store.js";
import { TrustedTelegramTransport } from "./trusted-telegram-transport.js";

process.umask(0o077);
const filename = process.argv[2];
if (!filename || process.argv.length !== 3 || process.getuid?.() === 0) throw new Error("Trusted broker requires its dedicated non-root service identity and configuration");
const config = await loadTrustedBrokerConfig(filename);
const store = new TrustedTelegramStore(config.databasePath, config.userId, config.initialOffset);
const telegram = new TrustedTelegramTransport(config.botToken, store);
const credentials = new ApprovedCredentialBroker(config.instance, store, new ApprovedLoginVault(config.vault), telegram);
let stopping = false;
const stop = () => { stopping = true; };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
try {
  await telegram.initialize();
  const server = await serveTrustedTelegram(config.socketPath, telegram, credentials);
  console.log("Trusted Telegram broker ready.");
  try {
    while (!stopping) {
      try { await telegram.pollOnce(); }
      catch {
        console.error("Trusted Telegram polling unavailable; retrying after delay.");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
} finally {
  store.close(); process.off("SIGTERM", stop); process.off("SIGINT", stop);
}
