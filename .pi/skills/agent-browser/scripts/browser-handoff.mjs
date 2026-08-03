#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";

const SESSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const DISPLAY_PATTERN = /^:\d+(?:\.\d+)?$/;
const START_TIMEOUT_MS = 10_000;
const scriptPath = fileURLToPath(import.meta.url);

function safeName(value, fallback) {
  const normalized = value?.trim().toLowerCase();
  return normalized && SESSION_PATTERN.test(normalized) ? normalized : fallback;
}

function paths(session) {
  const instance = safeName(process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID, "local");
  const runtimeBase =
    process.env.XDG_RUNTIME_DIR || join("/tmp", `pi-agent-browser-${process.getuid()}`);
  const runtimeDir = join(runtimeBase, "pi-agent-browser", instance, session);
  return {
    runtimeDir,
    browserStatePath: join(runtimeDir, "state.json"),
    handoffStatePath: join(runtimeDir, "handoff.json"),
    passwordPath: join(runtimeDir, "handoff-password"),
    logPath: join(runtimeDir, "handoff.log"),
  };
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

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function atomicPrivateWrite(path, contents) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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

function helperEnvironment() {
  const keys = [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "TZ",
    "XDG_RUNTIME_DIR",
    "PI_TELEGRAM_BRIDGE_INSTANCE_ID",
    // Test-only destinations contain no credentials.
    "X11_TEST_LOG",
    "WEBSOCKIFY_TEST_LOG",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Browser runtime path must be a real directory");
  }
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error("Browser runtime path must be owned by the service user");
  }
  await chmod(path, 0o700);
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

async function portReady(port) {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function browserEndpointReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const value = await response.json();
    return typeof value?.Browser === "string" && value.Browser.length > 0;
  } catch {
    return false;
  }
}

async function waitForPort(port, processHandle) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error("Browser handoff helper exited during startup");
    }
    if (await portReady(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser handoff port did not open within ${START_TIMEOUT_MS}ms`);
}

async function childPids(pid) {
  try {
    const source = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return source
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    try {
      const source = await execute("ps", ["-axo", "pid=,ppid="]);
      return source
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([, parentPid]) => parentPid === pid)
        .map(([childPid]) => childPid)
        .filter((value) => Number.isSafeInteger(value) && value > 0);
    } catch {
      return [];
    }
  }
}

function execute(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function processTree(rootPid) {
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0 && seen.size < 128) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    queue.push(...(await childPids(pid)));
  }
  return [...seen];
}

async function commandLine(pid) {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean);
  } catch {
    try {
      return (await execute("ps", ["-ww", "-p", String(pid), "-o", "command="]))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

async function validateDisplayContext(display, xauthority) {
  if (!DISPLAY_PATTERN.test(display || "")) {
    throw new Error("Browser X display is unavailable");
  }
  if (!xauthority || !isAbsolute(xauthority)) {
    throw new Error("Browser X authority is unavailable");
  }
  const metadata = await lstat(xauthority);
  const uid = process.getuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Browser X authority is not a regular file");
  }
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error("Browser X authority must be owned by the service user");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Browser X authority must not be accessible by other users");
  }
  await access(xauthority, constants.R_OK);
  return { display, xauthority };
}

async function discoverBrowserContext(browserPid, port) {
  const processes = await Promise.all(
    (await processTree(browserPid)).map(async (pid) => ({
      pid,
      args: await commandLine(pid),
    })),
  );
  const chrome = processes.find(
    ({ args }) =>
      args.includes("--remote-debugging-address=127.0.0.1") &&
      args.includes(`--remote-debugging-port=${port}`) &&
      args.some((value) => value.startsWith("--user-data-dir=")),
  );
  if (!chrome) {
    throw new Error("Could not identify stock Chrome from its launch arguments");
  }
  for (const processInfo of processes) {
    if (
      !processInfo.args.some((value) => basename(value) === "Xvfb")
    ) {
      continue;
    }
    const display = processInfo.args.find((value) => DISPLAY_PATTERN.test(value));
    const authIndex = processInfo.args.indexOf("-auth");
    const xauthority = authIndex >= 0 ? processInfo.args[authIndex + 1] : undefined;
    try {
      const context = await validateDisplayContext(display, xauthority);
      return {
        ...context,
        chromePid: chrome.pid,
        xvfbPid: processInfo.pid,
      };
    } catch {
      // Inspect the next Xvfb process in the browser process tree.
    }
  }
  throw new Error("Could not identify stock Chrome's Xvfb display and authority");
}

function validHandoffState(state) {
  return (
    state?.version === 1 &&
    Number.isSafeInteger(state.supervisorPid) &&
    Number.isSafeInteger(state.x11Pid) &&
    Number.isSafeInteger(state.websockifyPid) &&
    Number.isSafeInteger(state.webPort) &&
    Number.isSafeInteger(state.vncPort) &&
    typeof state.x11vncPath === "string" &&
    typeof state.websockifyPath === "string" &&
    typeof state.expiresAt === "string" &&
    typeof state.passwordPath === "string"
  );
}

async function supervisorAlive(pid, session) {
  if (!pidAlive(pid)) return false;
  const args = await commandLine(pid);
  return args.includes(scriptPath) && args.includes("serve") && args.includes(session);
}

async function trustedHandoffChild(state, kind) {
  const isX11 = kind === "x11vnc";
  const pid = isX11 ? state.x11Pid : state.websockifyPid;
  if (!pidAlive(pid)) return false;
  const args = await commandLine(pid);
  if (isX11) {
    return (
      args.includes(state.x11vncPath) &&
      args.includes("-rfbport") &&
      args.includes(String(state.vncPort)) &&
      args.includes("-passwdfile") &&
      args.includes(state.passwordPath)
    );
  }
  return (
    args.includes(state.websockifyPath) &&
    args.includes(`127.0.0.1:${state.webPort}`) &&
    args.includes(`127.0.0.1:${state.vncPort}`)
  );
}

async function waitUntilStopped(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while ((await check()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await check());
}

async function terminateSpawnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  if (
    await waitUntilStopped(
      async () => child.exitCode === null && child.signalCode === null,
      1_000,
    )
  ) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitUntilStopped(
    async () => child.exitCode === null && child.signalCode === null,
    1_000,
  );
}

async function terminateStateProcesses(state, session) {
  if (await supervisorAlive(state.supervisorPid, session)) {
    try {
      process.kill(-state.supervisorPid, "SIGTERM");
    } catch {
      // The supervisor exited between validation and signaling.
    }
    if (
      !(await waitUntilStopped(
        () => supervisorAlive(state.supervisorPid, session),
        2_000,
      ))
    ) {
      try {
        process.kill(-state.supervisorPid, "SIGKILL");
      } catch {
        // The supervisor exited before escalation.
      }
      await waitUntilStopped(
        () => supervisorAlive(state.supervisorPid, session),
        1_000,
      );
    }
  }
  for (const kind of ["websockify", "x11vnc"]) {
    if (!(await trustedHandoffChild(state, kind))) continue;
    const pid = kind === "x11vnc" ? state.x11Pid : state.websockifyPid;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    if (
      !(await waitUntilStopped(
        () => trustedHandoffChild(state, kind),
        1_000,
      ))
    ) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The verified child exited before escalation.
      }
    }
  }
}

async function current(session) {
  const resolved = paths(session);
  const state = await readJson(resolved.handoffStatePath);
  if (
    validHandoffState(state) &&
    (await supervisorAlive(state.supervisorPid, session)) &&
    Date.parse(state.expiresAt) > Date.now() &&
    (await portReady(state.webPort))
  ) {
    return state;
  }
  if (state) {
    if (validHandoffState(state)) await terminateStateProcesses(state, session);
    await Promise.all([
      rm(resolved.handoffStatePath, { force: true }),
      rm(resolved.passwordPath, { force: true }),
      rm(resolved.logPath, { force: true }),
    ]);
  }
  return undefined;
}

function publicState(state, session) {
  return {
    status: "running",
    session,
    webPort: state.webPort,
    expiresAt: state.expiresAt,
    passwordPath: state.passwordPath,
    path: "/vnc.html?autoconnect=1&resize=scale",
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseMinutes(args) {
  const raw = option(args, "--minutes") || "10";
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
    throw new Error("Handoff duration must be between 1 and 30 minutes");
  }
  return minutes;
}

async function start(session, args) {
  const minutes = parseMinutes(args);
  const existing = await current(session);
  if (existing) return publicState(existing, session);

  const resolved = paths(session);
  const browser = await readJson(resolved.browserStatePath);
  if (
    browser?.version !== 1 ||
    !Number.isSafeInteger(browser.pid) ||
    !Number.isSafeInteger(browser.port) ||
    !pidAlive(browser.pid) ||
    !(await browserEndpointReady(browser.port))
  ) {
    throw new Error("Stock Chrome session is not running");
  }
  const display = await discoverBrowserContext(browser.pid, browser.port);
  const [x11vnc, websockify] = await Promise.all([
    executable("x11vnc", process.env.STOCK_BROWSER_HANDOFF_X11VNC),
    executable("websockify", process.env.STOCK_BROWSER_HANDOFF_WEBSOCKIFY),
  ]);
  const webRoot = process.env.STOCK_BROWSER_HANDOFF_WEB_ROOT || "/usr/share/novnc";
  await access(join(webRoot, "vnc.html"), constants.R_OK);
  const [vncPort, webPort] = await Promise.all([
    reserveLoopbackPort(),
    reserveLoopbackPort(),
  ]);
  const expiresAtMs = Date.now() + minutes * 60_000;
  await ensurePrivateDirectory(resolved.runtimeDir);
  const supervisor = spawn(
    process.execPath,
    [
      scriptPath,
      "serve",
      session,
      "--display",
      display.display,
      "--xauthority",
      display.xauthority,
      "--x11vnc",
      x11vnc,
      "--websockify",
      websockify,
      "--web-root",
      webRoot,
      "--vnc-port",
      String(vncPort),
      "--web-port",
      String(webPort),
      "--expires-at-ms",
      String(expiresAtMs),
    ],
    { detached: true, stdio: "ignore", env: helperEnvironment() },
  );
  supervisor.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readJson(resolved.handoffStatePath);
    if (
      validHandoffState(state) &&
      state.supervisorPid === supervisor.pid &&
      (await portReady(state.webPort))
    ) {
      return publicState(state, session);
    }
    if (!pidAlive(supervisor.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(-supervisor.pid, "SIGTERM");
  } catch {
    // The failed supervisor already exited.
  }
  if (
    !(await waitUntilStopped(
      () => supervisorAlive(supervisor.pid, session),
      2_000,
    ))
  ) {
    try {
      process.kill(-supervisor.pid, "SIGKILL");
    } catch {
      // The failed supervisor exited before escalation.
    }
  }
  await Promise.all([
    rm(resolved.handoffStatePath, { force: true }),
    rm(resolved.passwordPath, { force: true }),
    rm(resolved.logPath, { force: true }),
  ]);
  throw new Error("Browser handoff failed to start and was cleaned up");
}

async function stop(session) {
  const resolved = paths(session);
  const state = await readJson(resolved.handoffStatePath);
  if (validHandoffState(state)) await terminateStateProcesses(state, session);
  await Promise.all([
    rm(resolved.handoffStatePath, { force: true }),
    rm(resolved.passwordPath, { force: true }),
    rm(resolved.logPath, { force: true }),
  ]);
  return { status: "stopped", session };
}

async function serve(session, args) {
  const display = option(args, "--display");
  const xauthority = option(args, "--xauthority");
  const x11vnc = option(args, "--x11vnc");
  const websockify = option(args, "--websockify");
  const webRoot = option(args, "--web-root");
  const vncPort = Number(option(args, "--vnc-port"));
  const webPort = Number(option(args, "--web-port"));
  const expiresAtMs = Number(option(args, "--expires-at-ms"));
  if (
    !x11vnc ||
    !websockify ||
    !webRoot ||
    !Number.isSafeInteger(vncPort) ||
    !Number.isSafeInteger(webPort) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= Date.now()
  ) {
    throw new Error("Invalid browser handoff supervisor configuration");
  }
  await validateDisplayContext(display, xauthority);
  const resolved = paths(session);
  await ensurePrivateDirectory(resolved.runtimeDir);
  const password = randomBytes(8).toString("base64url").slice(0, 8);
  await atomicPrivateWrite(resolved.passwordPath, `${password}\n`);
  await rm(resolved.logPath, { force: true });
  const log = await open(resolved.logPath, "wx", 0o600);
  const x11 = spawn(
    x11vnc,
    [
      "-norc",
      "-display",
      display,
      "-auth",
      xauthority,
      "-localhost",
      "-rfbport",
      String(vncPort),
      "-passwdfile",
      resolved.passwordPath,
      "-forever",
      "-nevershared",
      "-noxdamage",
      "-quiet",
    ],
    { stdio: ["ignore", log.fd, log.fd] },
  );
  const web = spawn(
    websockify,
    [
      `--web=${webRoot}`,
      "--heartbeat=30",
      `127.0.0.1:${webPort}`,
      `127.0.0.1:${vncPort}`,
    ],
    { stdio: ["ignore", log.fd, log.fd] },
  );
  await log.close();

  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const requestStop = () => finish();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  x11.once("exit", requestStop);
  web.once("exit", requestStop);

  try {
    await Promise.all([waitForPort(vncPort, x11), waitForPort(webPort, web)]);
    const state = {
      version: 1,
      supervisorPid: process.pid,
      x11Pid: x11.pid,
      websockifyPid: web.pid,
      x11vncPath: x11vnc,
      websockifyPath: websockify,
      vncPort,
      webPort,
      expiresAt: new Date(expiresAtMs).toISOString(),
      passwordPath: resolved.passwordPath,
    };
    await atomicPrivateWrite(
      resolved.handoffStatePath,
      `${JSON.stringify(state)}\n`,
    );
    const remaining = Math.max(0, expiresAtMs - Date.now());
    await Promise.race([
      finished,
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
  } finally {
    await Promise.all([terminateSpawnedChild(web), terminateSpawnedChild(x11)]);
    await Promise.all([
      rm(resolved.handoffStatePath, { force: true }),
      rm(resolved.passwordPath, { force: true }),
      rm(resolved.logPath, { force: true }),
    ]);
  }
}

async function main() {
  const [command, requestedSession = "default", ...args] = process.argv.slice(2);
  const session = safeName(requestedSession);
  if (!session) throw new Error(`Invalid browser session name: ${requestedSession}`);
  if (command === "start") {
    process.stdout.write(`${JSON.stringify(await start(session, args))}\n`);
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
    process.stdout.write(`${JSON.stringify(await stop(session))}\n`);
    return;
  }
  if (command === "serve") {
    await serve(session, args);
    return;
  }
  throw new Error(
    `Usage: ${basename(process.argv[1])} <start|status|stop> [session] [--minutes 1-30]`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
