import { spawn } from "node:child_process";

import { resolveBridgeConfig } from "./config.js";
import { resolveTelegramExtensionPath } from "./package-paths.js";

const config = resolveBridgeConfig();
const extensionPath = resolveTelegramExtensionPath();
const piBinary = process.env.PI_BIN?.trim() || "pi";

console.log(`Opening Pi in ${config.cwd}.`);
console.log("Run /telegram-setup, pair the bot with /start, then exit Pi.");

const child = spawn(
  piBinary,
  ["-e", extensionPath, "--name", "Telegram bridge setup"],
  {
    cwd: config.cwd,
    env: process.env,
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  console.error(`Could not start Pi: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Pi exited from signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
