import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const helper = join(
  process.cwd(),
  ".pi/skills/agent-browser/scripts/stock-chrome.mjs",
);

describe("stock Chrome browser helper", () => {
  it("keeps a profile while safely managing Chrome and agent-browser over loopback CDP", async () => {
    const root = await mkdtemp(join(tmpdir(), "stock-chrome-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);

    const chrome = join(bin, "chrome");
    await writeFile(
      chrome,
      `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
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
    await writeFile(agentBrowser, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n");
    await Promise.all([chrome, xvfbRun, agentBrowser].map((path) => chmod(path, 0o755)));

    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: join(root, "run"),
      XDG_DATA_HOME: join(root, "data"),
      PI_TELEGRAM_BRIDGE_INSTANCE_ID: "test-instance",
      STOCK_BROWSER_CHROME: chrome,
      STOCK_BROWSER_XVFB_RUN: xvfbRun,
      STOCK_BROWSER_AGENT_BROWSER: agentBrowser,
    };

    await mkdir(env.XDG_RUNTIME_DIR, { recursive: true });
    try {
      const started = await execFileAsync(process.execPath, [helper, "start", "default"], {
        env,
      });
      const state = JSON.parse(started.stdout) as {
        status: string;
        port: number;
        profilePath: string;
      };
      expect(state).toMatchObject({ status: "running" });
      expect(state.port).toBeGreaterThan(0);

      const run = await execFileAsync(
        process.execPath,
        [helper, "run", "default", "--", "snapshot", "-i"],
        { env },
      );
      expect(run.stdout.trim()).toBe(`--cdp ${state.port} snapshot -i`);

      await writeFile(join(state.profilePath, "persistent-marker"), "kept");
      await execFileAsync(process.execPath, [helper, "stop", "default"], { env });
      const restarted = await execFileAsync(
        process.execPath,
        [helper, "start", "default"],
        { env },
      );
      expect(JSON.parse(restarted.stdout).profilePath).toBe(state.profilePath);
    } finally {
      await execFileAsync(process.execPath, [helper, "stop", "default"], { env }).catch(
        () => undefined,
      );
    }
  });
});
