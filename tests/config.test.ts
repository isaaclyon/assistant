import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasConfiguredTelegramToken,
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
  });

  it("honors explicit runtime paths", () => {
    const config = resolveBridgeConfig(
      {
        PI_CODING_AGENT_DIR: "/agent",
        PI_TELEGRAM_BRIDGE_CWD: "/workspace",
        PI_TELEGRAM_BRIDGE_STATE_DIR: "/state",
      },
      "/home/tester",
    );

    expect(config).toEqual({
      agentDir: "/agent",
      cwd: "/workspace",
      sessionDir: "/state/sessions",
      stateDir: "/state",
    });
  });
});

describe("Telegram ownership lock", () => {
  it("reads only the default pi-telegram ownership lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-locks-"));
    const path = join(dir, "locks.json");
    await writeFile(
      path,
      JSON.stringify({ "@llblab/pi-telegram": { pid: 123 } }),
    );

    await expect(readDefaultTelegramLock(path)).resolves.toEqual({ pid: 123 });
  });

  it("recovers only when no live owner holds the lock", () => {
    expect(shouldRecoverTelegramOwnership(undefined, 10, () => false)).toBe(true);
    expect(shouldRecoverTelegramOwnership({ pid: 10 }, 10, () => true)).toBe(false);
    expect(shouldRecoverTelegramOwnership({ pid: 20 }, 10, () => true)).toBe(false);
    expect(shouldRecoverTelegramOwnership({ pid: 20 }, 10, () => false)).toBe(true);
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
});
