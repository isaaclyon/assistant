import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  hasConfiguredTelegramToken,
  resolveBridgeConfig,
} from "./config.js";
import { renderServiceUnit } from "./service-unit.js";

const execFileAsync = promisify(execFile);
const config = resolveBridgeConfig();
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const telegramConfigPath = join(config.agentDir, "telegram.json");

if (!(await hasConfiguredTelegramToken(telegramConfigPath))) {
  throw new Error(
    "Telegram is not configured. Run `npm run telegram:setup` before installing the service.",
  );
}

const userUnitDir = join(homedir(), ".config", "systemd", "user");
const unitPath = join(userUnitDir, "pi-telegram-bridge.service");
await mkdir(userUnitDir, { recursive: true, mode: 0o700 });
await writeFile(
  unitPath,
  renderServiceUnit({ config, nodePath: process.execPath, projectDir }),
  { mode: 0o600 },
);

await execFileAsync("systemctl", ["--user", "daemon-reload"]);
await execFileAsync("systemctl", [
  "--user",
  "enable",
  "--now",
  "pi-telegram-bridge.service",
]);

console.log(`Installed and started ${unitPath}`);
console.log("Status: systemctl --user status pi-telegram-bridge.service");
console.log("Logs:   journalctl --user -u pi-telegram-bridge.service -f");
