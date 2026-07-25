import { createServer } from "node:net";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const handoff = join(
  process.cwd(),
  ".pi/skills/agent-browser/scripts/browser-handoff.mjs",
);

async function listenLoopback() {
  const server = createServer((socket) => {
    socket.once("data", () => {
      const body = '{"Browser":"Fake Chrome"}';
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return { server, port: address.port };
}

describe("temporary browser handoff", () => {
  it("serves one authenticated noVNC handoff on loopback and cleans it up", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-handoff-test-"));
    const runtimeRoot = join(root, "run");
    const browserRuntime = join(
      runtimeRoot,
      "pi-agent-browser",
      "test-instance",
      "default",
    );
    const bin = join(root, "bin");
    const webRoot = join(root, "novnc");
    const xauthority = join(root, "Xauthority");
    const x11Log = join(root, "x11-args.json");
    const websockifyLog = join(root, "websockify-args.json");
    await Promise.all([
      mkdir(browserRuntime, { recursive: true }),
      mkdir(bin),
      mkdir(webRoot),
    ]);
    await writeFile(join(webRoot, "vnc.html"), "noVNC");
    await writeFile(xauthority, "fake auth", { mode: 0o600 });

    const reservation = await listenLoopback();
    const browserPort = reservation.port;
    await new Promise<void>((resolve) => reservation.server.close(() => resolve()));
    const fakeBrowserScript = join(root, "fake-browser.cjs");
    const fakeXvfb = join(root, "Xvfb");
    await writeFile(
      fakeXvfb,
      `#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
    );
    await chmod(fakeXvfb, 0o755);
    await writeFile(
      fakeBrowserScript,
      `const { spawn } = require("node:child_process");
const http = require("node:http");
const portArg = process.argv.find((value) => value.startsWith("--remote-debugging-port="));
const port = Number(portArg.split("=")[1]);
const xvfb = spawn(process.execPath, [process.env.FAKE_XVFB, process.env.DISPLAY, "-auth", process.env.XAUTHORITY]);
const server = http.createServer((_req, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ Browser: "Fake Chrome" }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => {
  xvfb.kill("SIGTERM");
  server.close(() => process.exit(0));
});
setInterval(() => {}, 1000);
`,
    );
    const fakeBrowser = spawn(
      process.execPath,
      [
        fakeBrowserScript,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${browserPort}`,
        `--user-data-dir=${join(root, "profile")}`,
      ],
      {
        env: {
          ...process.env,
          DISPLAY: ":123",
          XAUTHORITY: xauthority,
          FAKE_XVFB: fakeXvfb,
        },
        stdio: "ignore",
      },
    );
    const browserDeadline = Date.now() + 5_000;
    while (Date.now() < browserDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${browserPort}/json/version`);
        if (response.ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await writeFile(
      join(browserRuntime, "state.json"),
      `${JSON.stringify({ version: 1, pid: fakeBrowser.pid, port: browserPort })}\n`,
      { mode: 0o600 },
    );

    const x11vnc = join(bin, "x11vnc");
    await writeFile(
      x11vnc,
      `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.X11_TEST_LOG, JSON.stringify({
  args,
  inheritedCredential: process.env.PI_CREDENTIAL_ISAAC_TEST
}));
const port = Number(args[args.indexOf("-rfbport") + 1]);
const server = net.createServer(() => {});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`,
    );

    const websockify = join(bin, "websockify");
    await writeFile(
      websockify,
      `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.WEBSOCKIFY_TEST_LOG, JSON.stringify({
  args,
  inheritedCredential: process.env.PI_CREDENTIAL_ISAAC_TEST
}));
const source = args.find((value) => /^127\\.0\\.0\\.1:\\d+$/.test(value));
const port = Number(source.split(":")[1]);
const server = net.createServer(() => {});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`,
    );
    await Promise.all([x11vnc, websockify].map((path) => chmod(path, 0o755)));

    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeRoot,
      PI_TELEGRAM_BRIDGE_INSTANCE_ID: "test-instance",
      STOCK_BROWSER_HANDOFF_X11VNC: x11vnc,
      STOCK_BROWSER_HANDOFF_WEBSOCKIFY: websockify,
      STOCK_BROWSER_HANDOFF_WEB_ROOT: webRoot,
      X11_TEST_LOG: x11Log,
      WEBSOCKIFY_TEST_LOG: websockifyLog,
      PI_CREDENTIAL_ISAAC_TEST: "must-not-reach-handoff-helpers",
    };

    try {
      const started = await execFileAsync(
        process.execPath,
        [handoff, "start", "default", "--minutes", "5"],
        { env },
      );
      const state = JSON.parse(started.stdout) as {
        status: string;
        webPort: number;
        expiresAt: string;
        passwordPath: string;
      };
      expect(state).toMatchObject({ status: "running" });
      expect(state.webPort).toBeGreaterThan(0);
      expect(state.expiresAt).toMatch(/Z$/);
      expect(started.stdout).not.toContain("fake auth");

      const password = await readFile(state.passwordPath, "utf8");
      expect(password.trim()).toMatch(/^[A-Za-z0-9_-]{8}$/);
      expect(started.stdout).not.toContain(password.trim());
      expect((await stat(state.passwordPath)).mode & 0o777).toBe(0o600);

      const x11Invocation = JSON.parse(await readFile(x11Log, "utf8")) as {
        args: string[];
        inheritedCredential?: string;
      };
      const x11Args = x11Invocation.args;
      expect(x11Invocation.inheritedCredential).toBeUndefined();
      expect(x11Args).toEqual(
        expect.arrayContaining([
          "-localhost",
          "-display",
          ":123",
          "-auth",
          xauthority,
          "-passwdfile",
          state.passwordPath,
        ]),
      );
      expect(x11Args).not.toContain(password.trim());

      const websockifyInvocation = JSON.parse(
        await readFile(websockifyLog, "utf8"),
      ) as { args: string[]; inheritedCredential?: string };
      const websockifyArgs = websockifyInvocation.args;
      expect(websockifyInvocation.inheritedCredential).toBeUndefined();
      expect(websockifyArgs).toContain(`127.0.0.1:${state.webPort}`);
      expect(websockifyArgs).toContainEqual(expect.stringMatching(/^127\.0\.0\.1:\d+$/));
      expect(websockifyArgs).toContain(`--web=${webRoot}`);

      const status = await execFileAsync(
        process.execPath,
        [handoff, "status", "default"],
        { env },
      );
      expect(JSON.parse(status.stdout)).toMatchObject({
        status: "running",
        session: "default",
        webPort: state.webPort,
      });

      await execFileAsync(process.execPath, [handoff, "stop", "default"], { env });
      const stopped = await execFileAsync(
        process.execPath,
        [handoff, "status", "default"],
        { env },
      );
      expect(JSON.parse(stopped.stdout)).toEqual({
        status: "stopped",
        session: "default",
      });
      await expect(stat(state.passwordPath)).rejects.toThrow();
    } finally {
      fakeBrowser.kill("SIGTERM");
      await execFileAsync(process.execPath, [handoff, "stop", "default"], {
        env,
      }).catch(() => undefined);
    }
  });

  it("rejects unbounded handoff durations", async () => {
    await expect(
      execFileAsync(process.execPath, [handoff, "start", "default", "--minutes", "31"]),
    ).rejects.toThrow(/between 1 and 30 minutes/i);
  });

  it("does not signal an unrelated process after stale PID reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-handoff-stale-pid-"));
    const runtimeDir = join(
      root,
      "pi-agent-browser",
      "test-instance",
      "default",
    );
    await mkdir(runtimeDir, { recursive: true });
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    unrelated.unref();
    const passwordPath = join(runtimeDir, "handoff-password");
    await writeFile(passwordPath, "not-a-real-password\n", { mode: 0o600 });
    await writeFile(
      join(runtimeDir, "handoff.json"),
      `${JSON.stringify({
        version: 1,
        supervisorPid: unrelated.pid,
        webPort: 1,
        vncPort: 2,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        passwordPath,
      })}\n`,
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: root,
      PI_TELEGRAM_BRIDGE_INSTANCE_ID: "test-instance",
    };

    try {
      await execFileAsync(process.execPath, [handoff, "stop", "default"], { env });
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      try {
        process.kill(-unrelated.pid!, "SIGKILL");
      } catch {
        // The unrelated test process already exited.
      }
    }
  });
});
