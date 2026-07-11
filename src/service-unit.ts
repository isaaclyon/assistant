import { dirname, join } from "node:path";

import type { BridgeConfig } from "./config.js";

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeUnitPath(value: string): string {
  return value.replaceAll("\\", "\\x5c").replaceAll(" ", "\\x20");
}

export interface ServiceUnitOptions {
  config: BridgeConfig;
  nodePath: string;
  projectDir: string;
}

export function renderServiceUnit({
  config,
  nodePath,
  projectDir,
}: ServiceUnitOptions): string {
  const executable = join(projectDir, "dist", "src", "daemon.js");
  const path = [
    dirname(nodePath),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");

  return `[Unit]\nDescription=Persistent Pi Telegram bridge\nDocumentation=https://github.com/llblab/pi-telegram\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitPath(config.cwd)}\nExecStart=${quote(nodePath)} ${quote(executable)}\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=30s\nUMask=0077\nEnvironment=${quote(`PATH=${path}`)}\nEnvironment=${quote(`PI_CODING_AGENT_DIR=${config.agentDir}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_CWD=${config.cwd}`)}\nEnvironment=${quote(`PI_TELEGRAM_BRIDGE_STATE_DIR=${config.stateDir}`)}\n\n[Install]\nWantedBy=default.target\n`;
}
