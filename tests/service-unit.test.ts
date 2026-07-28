import { describe, expect, it } from "vitest";

import { resolveBridgeInstanceConfig } from "../src/config.js";
import { parseBridgeInstanceManifest } from "../src/instances.js";
import {
  renderInstanceServiceUnits,
  renderInstanceServiceUnit,
  renderServiceUnit,
} from "../src/service-unit.js";

describe("renderServiceUnit", () => {
  it("pins the node executable, persistent paths, and restart policy", () => {
    const unit = renderServiceUnit({
      config: {
        agentDir: "/home/test/.pi/agent",
        codexConfigPath: "/home/test/.config/telegram-codex.json",
        cwd: "/home/test",
        sessionDir: "/home/test/.local/state/pi-telegram-bridge/sessions",
        stateDir: "/home/test/.local/state/pi-telegram-bridge",
        webhookHost: "127.0.0.1",
        webhookPort: 8776,
      },
      nodePath: "/opt/node/bin/node",
      projectDir: "/srv/pi bridge",
      environmentFilePath: "/home/test/.config/pi-telegram-bridge/environment",
    });

    expect(unit).toContain(
      'ExecStart="/opt/node/bin/node" "/srv/pi bridge/dist/src/daemon.js"',
    );
    expect(unit).toContain("WorkingDirectory=/home/test");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain('Environment="PI_TELEGRAM_BRIDGE_CWD=/home/test"');
    expect(unit).toContain(
      'Environment="PI_TELEGRAM_CODEX_CONFIG=/home/test/.config/telegram-codex.json"',
    );
    expect(unit).toContain(
      "EnvironmentFile=-/home/test/.config/pi-telegram-bridge/environment",
    );
    expect(unit).not.toContain("PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT=");
    expect(unit.indexOf("EnvironmentFile=")).toBeGreaterThan(
      unit.indexOf("PI_TELEGRAM_CODEX_CONFIG="),
    );
    expect(unit).toContain("UMask=0077");
  });

  it("renders one identity-specific unit from the shared immutable release", () => {
    const manifest = parseBridgeInstanceManifest(
      JSON.stringify({
        version: 1,
        instances: [
          {
            id: "emma",
            displayName: "Emma Bot",
            principal: "emma",
            telegramProfile: "emma",
            telegramSurface: { type: "private" },
            workspaceCwd: "/srv/assistant-workspaces/emma",
            capabilityProfile: "personal-emma",
            credentialScope: "emma-personal",
            memoryView: "owner-and-household",
            jobsRole: "target-only",
          },
        ],
      }),
    );
    const config = resolveBridgeInstanceConfig(
      manifest,
      "emma",
      {
        PI_CODING_AGENT_DIR: "/home/test/.pi/agent",
        PI_TELEGRAM_BRIDGE_STATE_ROOT: "/var/lib/pi-telegram-bridge",
        PI_TELEGRAM_BRIDGE_CONFIG_ROOT: "/home/test/.config/pi-telegram-bridge",
      },
      "/home/test",
      "/srv/assistant/releases/abc123",
    );

    const rendered = renderInstanceServiceUnit({
      config,
      manifestPath: "/home/test/.config/pi-telegram-bridge/instances.json",
      nodePath: "/opt/node/bin/node",
      projectDir: "/srv/assistant/releases/abc123",
      releaseSha: "1234567890abcdef1234567890abcdef12345678",
    });

    expect(rendered.unitName).toBe("pi-telegram-bridge-emma.service");
    expect(rendered.contents).toContain(
      "Description=Persistent Pi Telegram bridge (Emma Bot / emma)",
    );
    expect(rendered.contents).toContain(
      "WorkingDirectory=/srv/assistant/releases/abc123",
    );
    expect(rendered.contents).toContain(
      'Environment="PI_TELEGRAM_BRIDGE_INSTANCE_ID=emma"',
    );
    expect(rendered.contents).toContain(
      'Environment="PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST=/home/test/.config/pi-telegram-bridge/instances.json"',
    );
    expect(rendered.contents).toContain(
      'Environment="PI_TELEGRAM_BRIDGE_RESOURCE_ROOT=/srv/assistant/releases/abc123"',
    );
    expect(rendered.contents).toContain(
      'Environment="PI_TELEGRAM_BRIDGE_RELEASE_SHA=1234567890abcdef1234567890abcdef12345678"',
    );
    expect(rendered.contents).toContain(
      'Environment="PI_TELEGRAM_BRIDGE_STATE_ROOT=/var/lib/pi-telegram-bridge"',
    );
    expect(rendered.contents).toContain(
      "EnvironmentFile=-/home/test/.config/pi-telegram-bridge/instances/emma.env",
    );
    expect(rendered.contents).toContain("Restart=on-failure");
    expect(rendered.contents).toContain("UMask=0077");
    expect(rendered.contents).not.toContain("emma-personal");
  });

  it("renders four collision-free units against one immutable release", () => {
    const releaseSha = "1234567890abcdef1234567890abcdef12345678";
    const definitions = [
      ["isaac", "Isaac Bot", "isaac", "personal-isaac", "isaac-personal", "owner-and-household", "coordinator"],
      ["emma", "Emma Bot", "emma", "personal-emma", "emma-personal", "owner-and-household", "target-only"],
      ["shared", "Shared Bot", "household", "household-shared", "household", "household", "target-only"],
      ["builder", "Builder Bot", "engineering", "builder", "engineering", "none", "disabled"],
    ] as const;
    const manifest = parseBridgeInstanceManifest(
      JSON.stringify({
        version: 1,
        instances: definitions.map(
          ([id, displayName, principal, capabilityProfile, credentialScope, memoryView, jobsRole]) => ({
            id,
            displayName,
            principal,
            telegramProfile: id,
            telegramSurface:
              id === "shared"
                ? {
                    type: "household-group",
                    chatId: -100123,
                    actors: { isaac: 101, emma: 202 },
                  }
                : { type: "private" },
            workspaceCwd: `/srv/workspaces/${id}`,
            capabilityProfile,
            credentialScope,
            memoryView,
            jobsRole,
          }),
        ),
      }),
    );
    const configs = manifest.instances.map((instance, index) =>
      resolveBridgeInstanceConfig(
        manifest,
        instance.id,
        {
          PI_CODING_AGENT_DIR: "/home/test/.pi/agent",
          PI_TELEGRAM_BRIDGE_STATE_ROOT: "/var/lib/pi-telegram-bridge",
          PI_TELEGRAM_BRIDGE_CONFIG_ROOT: "/home/test/.config/pi-telegram-bridge",
          PI_TELEGRAM_BRIDGE_WEBHOOK_PORT: String(8800 + index),
        },
        "/home/test",
        `/srv/assistant/releases/${releaseSha}`,
      ),
    );

    const units = renderInstanceServiceUnits({
      configs,
      manifestPath: "/home/test/.config/pi-telegram-bridge/instances.json",
      nodePath: "/opt/node/bin/node",
      projectDir: `/srv/assistant/releases/${releaseSha}`,
      releaseSha,
    });

    expect(units.map((unit) => unit.unitName)).toEqual([
      "pi-telegram-bridge-isaac.service",
      "pi-telegram-bridge-emma.service",
      "pi-telegram-bridge-shared.service",
      "pi-telegram-bridge-builder.service",
    ]);
    expect(
      units.every((unit) =>
        unit.contents.includes(`PI_TELEGRAM_BRIDGE_RELEASE_SHA=${releaseSha}`),
      ),
    ).toBe(true);
  });
});
