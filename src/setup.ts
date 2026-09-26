import { spawn } from "node:child_process";

import { resolveTelegramExtensionPath } from "./package-paths.js";

const cwd = process.cwd();
const extensionPath = resolveTelegramExtensionPath();
const piBinary = process.env.PI_BIN?.trim() || "pi";

console.log(`Opening Pi in ${cwd}.`);
console.log("Run /telegram-setup <profile> for each instance profile, pair each bot with /start, then exit Pi.");

const child = spawn(
  piBinary,
  ["-e", extensionPath, "--name", "Telegram bridge setup"],
  {
    cwd,
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
