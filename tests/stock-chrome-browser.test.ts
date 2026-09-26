import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const helper = join(
  process.cwd(),
  ".pi/skills/agent-browser/scripts/stock-chrome.mjs",
);

describe("stock Chrome browser helper", () => {
  it.each([false, true])("keeps a profile and pins its provider (inherited override: %s)", async (override) => {
    const root = await mkdtemp(join(tmpdir(), "stock-chrome-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);

    const chrome = join(bin, "chrome");
    await writeFile(
      chrome,
      `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
fs.appendFileSync(process.env.FAKE_PID_LOG, process.pid + "\\n");
const arg = process.argv.find((value) => value.startsWith("--user-data-dir="));
const profile = arg.slice("--user-data-dir=".length);
const portArg = process.argv.find((value) => value.startsWith("--remote-debugging-port="));
const requestedPort = Number(portArg.slice("--remote-debugging-port=".length));
if (!Number.isSafeInteger(requestedPort) || requestedPort <= 0) process.exit(42);
fs.mkdirSync(profile, { recursive: true });
const server = http.createServer((_req, res) => res.end('{"Browser":"Fake Chrome"}'));
server.listen(requestedPort, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(profile + "/DevToolsActivePort", port + "\\n/devtools/browser/test\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`,
    );

    const xvfbRun = join(bin, "xvfb-run");
    await writeFile(
      xvfbRun,
      `#!/bin/sh
shift
if [ "$1" = "--server-args" ]; then shift 2; fi
exec "$@"
`,
    );

    const agentBrowser = join(bin, "agent-browser");
    await writeFile(
      agentBrowser,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), plugins: JSON.parse(process.env.AGENT_BROWSER_PLUGINS) }));\n",
    );
    await Promise.all([chrome, xvfbRun, agentBrowser].map((path) => chmod(path, 0o755)));

    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: join(root, "run"),
      XDG_DATA_HOME: join(root, "data"),
      PI_TELEGRAM_BRIDGE_INSTANCE_ID: "test-instance",
      STOCK_BROWSER_CHROME: chrome,
      STOCK_BROWSER_XVFB_RUN: xvfbRun,
      STOCK_BROWSER_AGENT_BROWSER: agentBrowser,
      FAKE_PID_LOG: join(root, "pids"),
      AGENT_BROWSER_PLUGINS: JSON.stringify(override ? [{
        name: "onepassword", command: "/tmp/untrusted-provider", capabilities: ["credential.read"],
      }] : []),
    };

    await mkdir(env.XDG_RUNTIME_DIR, { recursive: true });
    try {
      const starts = await Promise.all([1, 2].map(() => execFileAsync(process.execPath, [helper, "start", "default"], { env })));
      const states = starts.map((result) => JSON.parse(result.stdout));
      expect(new Set(states.map((state) => state.port)).size).toBe(1);
      expect(states.filter((state) => state.created === true)).toHaveLength(1);
      const state = states[0] as {
        status: string;
        port: number;
        profilePath: string;
        launchId: string;
      };
      expect(state).toMatchObject({ status: "running" });
      expect(state.port).toBeGreaterThan(0);

      const run = await execFileAsync(
        process.execPath,
        [helper, "run", "default", "--", "snapshot", "-i"],
        { env },
      );
      const invocation = JSON.parse(run.stdout);
      expect(invocation.args).toEqual([
        "--cdp",
        String(state.port),
        "snapshot",
        "-i",
      ]);
      expect(invocation.plugins).toEqual([
        {
          name: "onepassword",
          command: join(
            process.cwd(),
            ".pi/skills/agent-browser/scripts/onepassword-credentials.mjs",
          ),
          capabilities: ["credential.read"],
        },
      ]);

      await writeFile(join(state.profilePath, "persistent-marker"), "kept");
      await execFileAsync(process.execPath, [helper, "stop", "default"], { env });
      const restarted = await execFileAsync(
        process.execPath,
        [helper, "start", "default"],
        { env },
      );
      expect(JSON.parse(restarted.stdout).profilePath).toBe(state.profilePath);
      const staleStop = await execFileAsync(process.execPath, [helper, "stop", "default", "--if-launch", state.launchId], { env });
      expect(JSON.parse(staleStop.stdout).status).toBe("not_owner");
      const stillRunning = await execFileAsync(process.execPath, [helper, "status", "default"], { env });
      expect(JSON.parse(stillRunning.stdout).status).toBe("running");
    } finally {
      await execFileAsync(process.execPath, [helper, "stop", "default"], { env }).catch(
        () => undefined,
      );
      for (const pid of (await readFile(env.FAKE_PID_LOG, "utf8").catch(() => "")).trim().split("\n").map(Number)) {
        if (pid > 0) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to signal an unrelated live process named by stale state", async () => {
    const root = await mkdtemp(join(tmpdir(), "stock-chrome-stale-"));
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const env = { ...process.env, XDG_RUNTIME_DIR: root, PI_TELEGRAM_BRIDGE_INSTANCE_ID: "test-instance" };
    const runtime = join(root, "pi-agent-browser/test-instance/default");
    try {
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      await writeFile(join(runtime, "state.json"), JSON.stringify({ version: 1, pid: unrelated.pid, port: 12345 }));
      const stopped = await execFileAsync(process.execPath, [helper, "stop", "default"], { env }).catch(() => undefined);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      expect(stopped).toBeUndefined();
    } finally {
      try { process.kill(-unrelated.pid!, "SIGKILL"); } catch { /* already gone */ }
      await rm(root, { recursive: true, force: true });
    }
  });
});
