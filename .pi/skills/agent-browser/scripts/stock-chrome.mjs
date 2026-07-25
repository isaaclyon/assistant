#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { createServer } from "node:net";

const START_TIMEOUT_MS = 15_000;
const SESSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function safeName(value, fallback) {
  const normalized = value?.trim().toLowerCase();
  return normalized && SESSION_PATTERN.test(normalized) ? normalized : fallback;
}

function paths(session) {
  const instance = safeName(
    process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID,
    "local",
  );
  const runtimeBase =
    process.env.XDG_RUNTIME_DIR || join("/tmp", `pi-agent-browser-${process.getuid()}`);
  const dataBase = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const runtimeDir = join(runtimeBase, "pi-agent-browser", instance, session);
  const profilePath = join(
    dataBase,
    "pi-telegram-bridge",
    "browser-profiles",
    instance,
    session,
  );
  return {
    runtimeDir,
    profilePath,
    statePath: join(runtimeDir, "state.json"),
    logPath: join(runtimeDir, "chrome.log"),
    devtoolsPath: join(profilePath, "DevToolsActivePort"),
  };
}

async function executable(name, override) {
  const candidates = override
    ? [override]
    : (process.env.PATH || "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Required executable not found: ${override || name}`);
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readState(statePath) {
  try {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    if (
      value?.version === 1 &&
      Number.isSafeInteger(value.pid) &&
      Number.isSafeInteger(value.port)
    ) {
      return value;
    }
  } catch {
    // Missing or malformed ephemeral state is stale.
  }
  return undefined;
}

async function endpointReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function current(session) {
  const resolved = paths(session);
  const state = await readState(resolved.statePath);
  if (state && pidAlive(state.pid) && (await endpointReady(state.port))) {
    return { ...state, ...resolved, status: "running" };
  }
  if (state) await rm(resolved.statePath, { force: true });
  return undefined;
}

async function start(session) {
  const existing = await current(session);
  if (existing) return existing;

  const resolved = paths(session);
  await mkdir(resolved.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(resolved.profilePath, { recursive: true, mode: 0o700 });
  await rm(resolved.devtoolsPath, { force: true });
  const port = await reserveLoopbackPort();

  const chrome = await executable(
    "google-chrome",
    process.env.STOCK_BROWSER_CHROME,
  );
  const xvfbRun = await executable(
    "xvfb-run",
    process.env.STOCK_BROWSER_XVFB_RUN,
  );
  const log = await open(resolved.logPath, "a", 0o600);
  const child = spawn(
    xvfbRun,
    [
      "-a",
      "--server-args",
      "-screen 0 1920x1080x24 -nolisten tcp",
      chrome,
      "--remote-debugging-address=127.0.0.1",
      // Chrome exposes navigator.webdriver when remote-debugging-port is zero.
      // Use an allocated nonzero loopback port to preserve ordinary Chrome behavior.
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${resolved.profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  child.unref();
  await log.close();

  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!pidAlive(child.pid)) throw new Error("Chrome exited during startup");
      if (await endpointReady(port)) {
        const state = {
          version: 1,
          pid: child.pid,
          port,
          profilePath: resolved.profilePath,
        };
        await writeFile(resolved.statePath, `${JSON.stringify(state)}\n`, {
          mode: 0o600,
        });
        return { ...state, ...resolved, status: "running" };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Chrome did not expose CDP within ${START_TIMEOUT_MS}ms`);
  } catch (error) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The failed process already exited.
    }
    throw error;
  }
}

async function stop(session) {
  const resolved = paths(session);
  const state = await readState(resolved.statePath);
  if (state && pidAlive(state.pid)) {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      // The process exited between inspection and signaling.
    }
    const deadline = Date.now() + 3_000;
    while (pidAlive(state.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (pidAlive(state.pid)) {
      try {
        process.kill(-state.pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }
  await rm(resolved.statePath, { force: true });
  process.stdout.write(`${JSON.stringify({ status: "stopped", session })}\n`);
}

function publicState(state, session) {
  return {
    status: state.status,
    session,
    port: state.port,
    profilePath: state.profilePath,
    logPath: state.logPath,
  };
}

async function main() {
  const [command, requestedSession = "default", ...rest] = process.argv.slice(2);
  const session = safeName(requestedSession);
  if (!session) throw new Error(`Invalid browser session name: ${requestedSession}`);

  if (command === "start") {
    process.stdout.write(`${JSON.stringify(publicState(await start(session), session))}\n`);
    return;
  }
  if (command === "status") {
    const state = await current(session);
    process.stdout.write(
      `${JSON.stringify(state ? publicState(state, session) : { status: "stopped", session })}\n`,
    );
    return;
  }
  if (command === "stop") {
    await stop(session);
    return;
  }
  if (command === "run") {
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    if (args.length === 0) throw new Error("run requires agent-browser arguments");
    const state = await start(session);
    const agentBrowser = await executable(
      "agent-browser",
      process.env.STOCK_BROWSER_AGENT_BROWSER,
    );
    const result = spawnSync(agentBrowser, ["--cdp", String(state.port), ...args], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  throw new Error(
    `Usage: ${basename(process.argv[1])} <start|status|stop|run> [session] [-- agent-browser args...]`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
