import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { prepareBridgeFleet } from "./fleet-config.js";
import { writeBridgeFleetUnits } from "./fleet-installer.js";

const execFileAsync = promisify(execFile);
const home = homedir();
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const userUnitDir = join(home, ".config", "systemd", "user");

function resolveFromHome(value: string | undefined, fallback: string): string {
  const selected = value?.trim() || fallback;
  return isAbsolute(selected) ? resolve(selected) : resolve(home, selected);
}

async function installInstanceFleet(): Promise<void> {
  const releaseSha = process.env.PI_TELEGRAM_BRIDGE_RELEASE_SHA?.trim() ?? "";
  const configRoot = resolveFromHome(
    process.env.PI_TELEGRAM_BRIDGE_CONFIG_ROOT,
    join(home, ".config", "pi-telegram-bridge"),
  );
  const manifestPath = resolveFromHome(
    process.env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST,
    join(configRoot, "instances.json"),
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

await installInstanceFleet();

console.log("Status: systemctl --user status 'pi-telegram-bridge*.service'");
console.log("Logs:   journalctl --user -u 'pi-telegram-bridge*.service' -f");
