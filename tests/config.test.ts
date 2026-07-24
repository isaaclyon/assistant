import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  hasConfiguredTelegramToken,
  ensureCodexConfig,
  isProcessAlive,
  loadBridgeInstanceConfig,
  loadBridgeRuntimeConfig,
  readDefaultTelegramLock,
  readTelegramLock,
  resolveBridgeConfig,
  resolveBridgeInstanceConfig,
  shouldRecoverTelegramOwnership,
} from "../src/config.js";
import { parseBridgeInstanceManifest } from "../src/instances.js";

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
    expect(config.sessionIdleMs).toBe(0);
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
      sessionIdleMs: 0,
      webhookHost: "127.0.0.1",
      webhookPort: 8776,
    });
  });

  it("parses an opt-in bounded session idle timeout", () => {
    expect(
      resolveBridgeConfig({ PI_TELEGRAM_SESSION_IDLE_HOURS: "8" }, "/home/tester")
        .sessionIdleMs,
    ).toBe(8 * 60 * 60 * 1_000);
    for (const value of ["nope", "-1", "Infinity", "8761"]) {
      expect(() =>
        resolveBridgeConfig({ PI_TELEGRAM_SESSION_IDLE_HOURS: value }, "/home/tester"),
      ).toThrow(/PI_TELEGRAM_SESSION_IDLE_HOURS.*0.*8760/i);
    }
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

describe("resolveBridgeInstanceConfig", () => {
  it("selects one stable instance and derives its resource, workspace, and private state boundaries", () => {
    const manifest = parseBridgeInstanceManifest(
      JSON.stringify({
        version: 1,
        instances: [
          {
            id: "isaac",
            displayName: "Isaac Bot",
            principal: "isaac",
            telegramProfile: "isaac",
            telegramSurface: { type: "private" },
            workspaceCwd: "/worktrees/isaac",
            capabilityProfile: "personal-isaac",
            credentialScope: "isaac-personal",
            memoryView: "owner-and-household",
            jobsRole: "coordinator",
          },
        ],
      }),
    );

    const config = resolveBridgeInstanceConfig(
      manifest,
      "isaac",
      {
        PI_TELEGRAM_BRIDGE_STATE_ROOT: "/state",
        PI_TELEGRAM_BRIDGE_CONFIG_ROOT: "/private-config",
        PI_CODING_AGENT_DIR: "/agent",
      },
      "/home/tester",
      "/opt/assistant/releases/abc123",
    );

    expect(config).toMatchObject({
      instanceId: "isaac",
      displayName: "Isaac Bot",
      principal: "isaac",
      telegramProfile: "isaac",
      telegramSurface: { type: "private" },
      resourceRoot: "/opt/assistant/releases/abc123",
      workspaceCwd: "/worktrees/isaac",
      capabilityProfile: "personal-isaac",
      credentialScope: "isaac-personal",
      memoryView: "owner-and-household",
      jobsRole: "coordinator",
      agentDir: "/agent",
      stateDir: "/state/instances/isaac",
      sessionDir: "/state/instances/isaac/sessions",
      inboxPath: "/state/instances/isaac/inbox.db",
      codexConfigPath: "/state/instances/isaac/pi-codex-conversion.json",
      restartMarkerPath: "/state/instances/isaac/restart-pending.json",
      runtimeMetadataPath: "/state/instances/isaac/runtime.json",
      checkerStateDir: "/state/instances/isaac/checkers",
      environmentFilePath: "/private-config/instances/isaac.env",
      sessionIdleMs: 0,
    });
  });

  it("loads the private production manifest and selects the service instance ID", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "bridge-instance-config-"));
    const manifestPath = join(configRoot, "instances.json");
    await mkdir(join(configRoot, "instances"), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            id: "emma",
            displayName: "Emma Bot",
            principal: "emma",
            telegramProfile: "emma",
            telegramSurface: { type: "private" },
            workspaceCwd: "/worktrees/emma",
            capabilityProfile: "personal-emma",
            credentialScope: "emma-personal",
            memoryView: "owner-and-household",
            jobsRole: "target-only",
          },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(configRoot, "instances", "emma.env"),
      "PI_TELEGRAM_CREDENTIAL_SCOPE=emma-personal\n",
      { mode: 0o600 },
    );

    await expect(
      loadBridgeInstanceConfig(
        {
          PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST: manifestPath,
          PI_TELEGRAM_BRIDGE_INSTANCE_ID: "emma",
          PI_TELEGRAM_BRIDGE_STATE_ROOT: "/state",
          PI_TELEGRAM_BRIDGE_CONFIG_ROOT: configRoot,
        },
        "/home/tester",
        "/opt/assistant/releases/abc123",
      ),
    ).resolves.toMatchObject({
      instanceId: "emma",
      principal: "emma",
      workspaceCwd: "/worktrees/emma",
      stateDir: "/state/instances/emma",
      environmentFilePath: join(configRoot, "instances", "emma.env"),
    });
  });

  it("keeps the current singleton paths only when no instance migration is configured", async () => {
    await expect(
      loadBridgeRuntimeConfig(
        {
          PI_TELEGRAM_BRIDGE_CWD: "/srv/current-assistant",
          PI_TELEGRAM_BRIDGE_STATE_DIR: "/state/current-assistant",
        },
        "/home/tester",
        "/opt/assistant/releases/abc123",
      ),
    ).resolves.toEqual({
      agentDir: "/home/tester/.pi/agent",
      codexConfigPath: "/state/current-assistant/pi-codex-conversion.json",
      cwd: "/srv/current-assistant",
      sessionDir: "/state/current-assistant/sessions",
      stateDir: "/state/current-assistant",
      sessionIdleMs: 0,
      webhookHost: "127.0.0.1",
      webhookPort: 8776,
    });
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

  it("reads only the selected named-profile ownership lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-profile-locks-"));
    const path = join(dir, "locks.json");
    await writeFile(
      path,
      JSON.stringify({
        "@llblab/pi-telegram": { pid: 100 },
        "@llblab/pi-telegram:isaac": { pid: 101, heartbeatMs: 500 },
        "@llblab/pi-telegram:emma": { pid: 102 },
      }),
    );

    await expect(readTelegramLock(path, "isaac")).resolves.toEqual({
      pid: 101,
      heartbeatMs: 500,
    });
    await expect(readTelegramLock(path, "emma")).resolves.toEqual({ pid: 102 });
    await expect(readTelegramLock(path, "missing")).resolves.toBeUndefined();
    await expect(readTelegramLock(path, "default")).resolves.toEqual({ pid: 100 });
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

  it("recognizes only the selected named Telegram profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-profile-config-"));
    const path = join(dir, "telegram.json");
    await writeFile(
      path,
      JSON.stringify({
        botToken: "default-secret",
        profiles: {
          isaac: { botToken: "isaac-secret" },
          blank: { botToken: "   " },
        },
      }),
      { mode: 0o600 },
    );

    await expect(hasConfiguredTelegramToken(path, "isaac")).resolves.toBe(true);
    await expect(hasConfiguredTelegramToken(path, "missing")).resolves.toBe(false);
    await expect(hasConfiguredTelegramToken(path, "blank")).resolves.toBe(false);
    await expect(hasConfiguredTelegramToken(path, "default")).resolves.toBe(true);
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
