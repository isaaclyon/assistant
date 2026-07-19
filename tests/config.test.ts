import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  hasConfiguredTelegramToken,
  ensureCodexConfig,
  isProcessAlive,
  readDefaultTelegramLock,
  resolveBridgeConfig,
  shouldRecoverTelegramOwnership,
} from "../src/config.js";

describe("resolveBridgeConfig", () => {
  it("uses a dedicated state directory and the home directory as the agent cwd", () => {
    const config = resolveBridgeConfig({}, "/home/tester", "/srv/assistant");

    expect(config.cwd).toBe("/srv/assistant");
    expect(config.agentDir).toBe("/home/tester/.pi/agent");
    expect(config.stateDir).toBe(
      "/home/tester/.local/state/pi-telegram-bridge",
    );
    expect(config.sessionDir).toBe(
      "/home/tester/.local/state/pi-telegram-bridge/sessions",
    );
    expect(config.codexConfigPath).toBe(
      "/home/tester/.local/state/pi-telegram-bridge/pi-codex-conversion.json",
    );
  });

  it("honors explicit runtime paths", () => {
    const config = resolveBridgeConfig(
      {
        PI_CODING_AGENT_DIR: "/agent",
        PI_TELEGRAM_BRIDGE_CWD: "/workspace",
        PI_TELEGRAM_BRIDGE_STATE_DIR: "/state",
        PI_TELEGRAM_CODEX_CONFIG: "/config/codex.json",
      },
      "/home/tester",
    );

    expect(config).toEqual({
      agentDir: "/agent",
      codexConfigPath: "/config/codex.json",
      cwd: "/workspace",
      sessionDir: "/state/sessions",
      stateDir: "/state",
      webhookHost: "127.0.0.1",
      webhookPort: 8776,
    });
  });

  it("honors webhook listener overrides and rejects invalid ports", () => {
    const config = resolveBridgeConfig(
      {
        PI_TELEGRAM_BRIDGE_WEBHOOK_HOST: "0.0.0.0",
        PI_TELEGRAM_BRIDGE_WEBHOOK_PORT: "9000",
      },
      "/home/tester",
    );
    expect(config.webhookHost).toBe("0.0.0.0");
    expect(config.webhookPort).toBe(9000);
    expect(() =>
      resolveBridgeConfig({ PI_TELEGRAM_BRIDGE_WEBHOOK_PORT: "not-a-port" }, "/home/tester"),
    ).toThrow(/port number/);
  });
});

describe("ensureCodexConfig", () => {
  it("creates an explicit private normal-mode config without replacing an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-codex-config-"));
    const path = join(dir, "nested", "codex.json");

    await ensureCodexConfig(path);
    await expect(readFile(path, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          mode: "normal",
          tools: { imageGeneration: false, imageGenerationOnly: false },
        },
        null,
        2,
      )}\n`,
    );

    await writeFile(
      path,
      JSON.stringify({
        mode: "path",
        tools: { webRun: false },
        openai: { fast: true },
      }),
    );
    await ensureCodexConfig(path);
    await expect(readFile(path, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          mode: "path",
          tools: {
            webRun: false,
            imageGeneration: false,
            imageGenerationOnly: false,
          },
          openai: { fast: true },
        },
        null,
        2,
      )}\n`,
    );
  });
});

describe("Telegram ownership lock", () => {
  it("reads only the default pi-telegram ownership lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-locks-"));
    const path = join(dir, "locks.json");
    await writeFile(
      path,
      JSON.stringify({
        "@llblab/pi-telegram": { pid: 123, heartbeatMs: 456 },
      }),
    );

    await expect(readDefaultTelegramLock(path)).resolves.toEqual({
      pid: 123,
      heartbeatMs: 456,
    });
  });

  it("rejects invalid process identifiers in ownership locks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-locks-"));
    const path = join(dir, "locks.json");

    for (const pid of [0, -1, 1.5]) {
      await writeFile(
        path,
        JSON.stringify({ "@llblab/pi-telegram": { pid } }),
      );
      await expect(readDefaultTelegramLock(path)).resolves.toBeUndefined();
    }
  });

  it("checks only positive pids and treats permission denial as alive", () => {
    const kill = vi.fn<(pid: number, signal: 0) => void>();
    expect(isProcessAlive(0, kill)).toBe(false);
    expect(isProcessAlive(-1, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();

    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(isProcessAlive(12, kill)).toBe(true);
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    expect(isProcessAlive(13, kill)).toBe(false);
  });

  it("recovers when no live owner holds the lock or its heartbeat is stale", () => {
    expect(shouldRecoverTelegramOwnership(undefined, 10, () => false)).toBe(true);
    expect(shouldRecoverTelegramOwnership({ pid: 10 }, 10, () => true)).toBe(false);
    expect(shouldRecoverTelegramOwnership({ pid: 20 }, 10, () => true)).toBe(false);
    expect(shouldRecoverTelegramOwnership({ pid: 20 }, 10, () => false)).toBe(true);
    expect(
      shouldRecoverTelegramOwnership(
        { pid: 20, heartbeatMs: 1_000 },
        10,
        () => true,
        6_001,
      ),
    ).toBe(true);
    expect(
      shouldRecoverTelegramOwnership(
        { pid: 20, heartbeatMs: 1_001 },
        10,
        () => true,
        6_001,
      ),
    ).toBe(false);
    expect(
      shouldRecoverTelegramOwnership(
        { pid: 10, heartbeatMs: 1_000 },
        10,
        () => true,
        6_001,
      ),
    ).toBe(true);
  });
});

describe("hasConfiguredTelegramToken", () => {
  it("recognizes a configured default profile without exposing the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
    const path = join(dir, "telegram.json");
    await writeFile(path, JSON.stringify({ botToken: "secret" }), { mode: 0o600 });

    await expect(hasConfiguredTelegramToken(path)).resolves.toBe(true);
  });

  it("returns false for missing, malformed, or blank configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
    await writeFile(join(dir, "bad.json"), "not json");
    await writeFile(
      join(dir, "blank.json"),
      JSON.stringify({ botToken: "   " }),
    );

    await expect(hasConfiguredTelegramToken(join(dir, "missing.json"))).resolves.toBe(false);
    await expect(hasConfiguredTelegramToken(join(dir, "bad.json"))).resolves.toBe(false);
    await expect(hasConfiguredTelegramToken(join(dir, "blank.json"))).resolves.toBe(false);
  });

  it("surfaces configuration I/O failures instead of reporting setup missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));

    await expect(hasConfiguredTelegramToken(dir)).rejects.toThrow(
      /Could not read JSON file/,
    );
  });
});
