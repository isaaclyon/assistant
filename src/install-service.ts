import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  hasConfiguredTelegramToken,
  resolveBridgeConfig,
} from "./config.js";
import { prepareBridgeFleet } from "./fleet-config.js";
import { writeBridgeFleetUnits } from "./fleet-installer.js";
import { renderServiceUnit } from "./service-unit.js";

const execFileAsync = promisify(execFile);
const home = homedir();
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const userUnitDir = join(home, ".config", "systemd", "user");

function resolveFromHome(value: string | undefined, fallback: string): string {
  const selected = value?.trim() || fallback;
  return isAbsolute(selected) ? resolve(selected) : resolve(home, selected);
}

async function installLegacyService(): Promise<void> {
  const config = resolveBridgeConfig();
  const telegramConfigPath = join(config.agentDir, "telegram.json");
  if (!(await hasConfiguredTelegramToken(telegramConfigPath))) {
    throw new Error(
      "Telegram is not configured. Run `npm run telegram:setup` before installing the service.",
    );
  }

  const unitName = "pi-telegram-bridge.service";
  const unitPath = join(userUnitDir, unitName);
  const environmentFilePath = join(
    home,
    ".config",
    "pi-telegram-bridge",
    "environment",
  );
  await mkdir(userUnitDir, { recursive: true, mode: 0o700 });
  await writeFile(
    unitPath,
    renderServiceUnit({
      config,
      environmentFilePath,
      nodePath: process.execPath,
      projectDir,
    }),
    { mode: 0o600 },
  );
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", unitName]);
  console.log(`Installed and started ${unitPath}`);
}

async function installInstanceFleet(manifestPath: string): Promise<void> {
  const releaseSha = process.env.PI_TELEGRAM_BRIDGE_RELEASE_SHA?.trim() ?? "";
  const configRoot = resolveFromHome(
    process.env.PI_TELEGRAM_BRIDGE_CONFIG_ROOT,
    join(home, ".config", "pi-telegram-bridge"),
  );
  const resourceRoot = resolveFromHome(
    process.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT,
    projectDir,
  );
  const fleet = await prepareBridgeFleet({
    manifestPath,
    resourceRoot,
    stateRoot: resolveFromHome(
      process.env.PI_TELEGRAM_BRIDGE_STATE_ROOT,
      join(home, ".local", "state", "pi-telegram-bridge"),
    ),
    configRoot,
    agentDir: resolveFromHome(
      process.env.PI_CODING_AGENT_DIR,
      join(home, ".pi", "agent"),
    ),
    releaseSha,
    nodePath: process.execPath,
  });
  const unitPaths = await writeBridgeFleetUnits(userUnitDir, fleet.units);
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  if (process.env.PI_TELEGRAM_BRIDGE_INSTALL_NO_START !== "1") {
    await execFileAsync("systemctl", [
      "--user",
      "enable",
      "--now",
      ...fleet.units.map((unit) => unit.unitName),
    ]);
  }
  console.log(
    `${process.env.PI_TELEGRAM_BRIDGE_INSTALL_NO_START === "1" ? "Installed" : "Installed and started"} ${unitPaths.length} bridge instances on release ${releaseSha}.`,
  );
}

const configuredManifest = process.env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST?.trim();
if (configuredManifest) {
  await installInstanceFleet(resolveFromHome(configuredManifest, configuredManifest));
} else {
  await installLegacyService();
}

console.log("Status: systemctl --user status 'pi-telegram-bridge*.service'");
console.log("Logs:   journalctl --user -u 'pi-telegram-bridge*.service' -f");
