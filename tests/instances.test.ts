import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadBridgeInstanceManifest,
  parseBridgeInstanceManifest,
  resolveBridgeInstancePaths,
  selectBridgeInstance,
} from "../src/instances.js";

function personalInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "isaac",
    displayName: "Isaac Bot",
    principal: "isaac",
    telegramProfile: "isaac",
    telegramSurface: { type: "private" },
    workspaceCwd: "/srv/assistant-workspaces/isaac",
    capabilityProfile: "personal-isaac",
    credentialScope: "isaac-personal",
    memoryView: "owner-and-household",
    jobsRole: "coordinator",
    ...overrides,
  };
}

describe("bridge instance manifest", () => {
  it("parses a valid personal instance and selects it by stable ID", () => {
    const manifest = parseBridgeInstanceManifest(
      JSON.stringify({
        version: 1,
        instances: [personalInstance()],
      }),
    );

    expect(selectBridgeInstance(manifest, "isaac")).toEqual({
      id: "isaac",
      displayName: "Isaac Bot",
      principal: "isaac",
      telegramProfile: "isaac",
      telegramSurface: { type: "private" },
      workspaceCwd: "/srv/assistant-workspaces/isaac",
      capabilityProfile: "personal-isaac",
      credentialScope: "isaac-personal",
      memoryView: "owner-and-household",
      jobsRole: "coordinator",
    });
  });

  it("rejects duplicate instance IDs", () => {
    const instance = personalInstance();

    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({ version: 1, instances: [instance, instance] }),
      ),
    ).toThrow('Duplicate bridge instance ID: "isaac"');
  });

  it.each(["Isaac Bot", "../isaac", "isaac_bot", "-isaac"])(
    "rejects unsafe instance ID %s",
    (id) => {
      expect(() =>
        parseBridgeInstanceManifest(
          JSON.stringify({ version: 1, instances: [personalInstance({ id })] }),
        ),
      ).toThrow(/instances\[0\]\.id must be a lowercase slug/);
    },
  );

  it("rejects a relative workspace cwd", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [personalInstance({ workspaceCwd: "worktrees/isaac" })],
        }),
      ),
    ).toThrow("instances[0].workspaceCwd must be an absolute path");
  });

  it("parses a household group with two trusted Telegram actors", () => {
    const manifest = parseBridgeInstanceManifest(
      JSON.stringify({
        version: 1,
        instances: [
          personalInstance({
            id: "shared",
            displayName: "Shared Bot",
            principal: "household",
            telegramProfile: "shared",
            telegramSurface: {
              type: "household-group",
              chatId: -1001234567890,
              actors: { isaac: 111, emma: 222 },
            },
            workspaceCwd: "/srv/assistant-workspaces/shared",
            capabilityProfile: "household-shared",
            credentialScope: "household",
            memoryView: "household",
            jobsRole: "target-only",
          }),
        ],
      }),
    );

    expect(selectBridgeInstance(manifest, "shared").telegramSurface).toEqual({
      type: "household-group",
      chatId: -1001234567890,
      actors: { isaac: 111, emma: 222 },
    });
  });

  it("rejects a personal memory view for the household principal", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              id: "shared",
              principal: "household",
              telegramProfile: "shared",
              telegramSurface: {
                type: "household-group",
                chatId: -1001234567890,
                actors: { isaac: 111, emma: 222 },
              },
              memoryView: "owner-and-household",
              credentialScope: "household",
            }),
          ],
        }),
      ),
    ).toThrow("instances[0] household principal must use household memory");
  });

  it("rejects a personal credential scope for the household principal", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              id: "shared",
              principal: "household",
              telegramProfile: "shared",
              telegramSurface: {
                type: "household-group",
                chatId: -1001234567890,
                actors: { isaac: 111, emma: 222 },
              },
              memoryView: "household",
              credentialScope: "isaac-personal",
            }),
          ],
        }),
      ),
    ).toThrow(
      "instances[0] household principal must use the household credential scope",
    );
  });

  it("binds the household-group surface exclusively to the household principal", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              id: "shared",
              principal: "household",
              telegramProfile: "shared",
              telegramSurface: { type: "private" },
              memoryView: "household",
              credentialScope: "household",
            }),
          ],
        }),
      ),
    ).toThrow("instances[0] household principal must use a household-group surface");

    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              telegramSurface: {
                type: "household-group",
                chatId: -1001234567890,
                actors: { isaac: 111, emma: 222 },
              },
            }),
          ],
        }),
      ),
    ).toThrow("instances[0] household-group surface requires the household principal");
  });

  it("rejects more than one jobs coordinator", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance(),
            personalInstance({
              id: "emma",
              displayName: "Emma Bot",
              principal: "emma",
              telegramProfile: "emma",
              workspaceCwd: "/srv/assistant-workspaces/emma",
              capabilityProfile: "personal-emma",
              credentialScope: "emma-personal",
            }),
          ],
        }),
      ),
    ).toThrow("Bridge instance manifest must define at most one jobs coordinator");
  });

  it("rejects duplicate workspace paths", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({ jobsRole: "target-only" }),
            personalInstance({
              id: "emma",
              displayName: "Emma Bot",
              principal: "emma",
              telegramProfile: "emma",
              capabilityProfile: "personal-emma",
              credentialScope: "emma-personal",
              jobsRole: "target-only",
            }),
          ],
        }),
      ),
    ).toThrow(
      'Duplicate bridge instance workspaceCwd "/srv/assistant-workspaces/isaac"',
    );
  });

  it("rejects duplicate Telegram profiles", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({ jobsRole: "target-only" }),
            personalInstance({
              id: "emma",
              displayName: "Emma Bot",
              principal: "emma",
              workspaceCwd: "/srv/assistant-workspaces/emma",
              capabilityProfile: "personal-emma",
              credentialScope: "emma-personal",
              jobsRole: "target-only",
            }),
          ],
        }),
      ),
    ).toThrow('Duplicate bridge instance telegramProfile "isaac"');
  });

  it.each(["Isaac Bot", "default", "main", "active", "with-dash", "a".repeat(33)])(
    "rejects invalid or reserved named Telegram profile %s",
    (telegramProfile) => {
      expect(() =>
        parseBridgeInstanceManifest(
          JSON.stringify({
            version: 1,
            instances: [personalInstance({ telegramProfile })],
          }),
        ),
      ).toThrow(/telegramProfile must be a lowercase alphanumeric named profile/i);
    },
  );

  it("rejects duplicate household Telegram actor IDs", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              id: "shared",
              principal: "household",
              telegramProfile: "shared",
              telegramSurface: {
                type: "household-group",
                chatId: -1001234567890,
                actors: { isaac: 111, emma: 111 },
              },
              memoryView: "household",
              credentialScope: "household",
            }),
          ],
        }),
      ),
    ).toThrow("instances[0].telegramSurface actor IDs must be distinct");
  });

  it.each([
    ["isaac", "household", "personal principal must use owner-and-household memory"],
    ["emma", "none", "personal principal must use owner-and-household memory"],
    ["engineering", "owner-and-household", "engineering principal must use no memory"],
  ])("rejects %s principal with %s memory", (principal, memoryView, message) => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [personalInstance({ principal, memoryView })],
        }),
      ),
    ).toThrow(`instances[0] ${message}`);
  });

  it.each([
    ["isaac", "emma-personal", "isaac-personal"],
    ["emma", "isaac-personal", "emma-personal"],
    ["engineering", "household", "engineering"],
  ])(
    "rejects %s principal with %s credentials",
    (principal, credentialScope, expectedScope) => {
      const memoryView = principal === "engineering" ? "none" : "owner-and-household";
      expect(() =>
        parseBridgeInstanceManifest(
          JSON.stringify({
            version: 1,
            instances: [
              personalInstance({ principal, credentialScope, memoryView }),
            ],
          }),
        ),
      ).toThrow(`instances[0] ${principal} principal must use ${expectedScope} credentials`);
    },
  );

  it("rejects unknown manifest and instance fields", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({ version: 1, instances: [personalInstance()], typo: true }),
      ),
    ).toThrow('Bridge instance manifest has unknown field "typo"');

    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [personalInstance({ credentialsScope: "isaac-personal" })],
        }),
      ),
    ).toThrow('instances[0] has unknown field "credentialsScope"');
  });

  it("loads a valid manifest from the private external configuration path", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-instances-"));
    const path = join(root, "instances.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, instances: [personalInstance()] }),
      { mode: 0o600 },
    );

    await expect(loadBridgeInstanceManifest(path)).resolves.toEqual(
      parseBridgeInstanceManifest(
        JSON.stringify({ version: 1, instances: [personalInstance()] }),
      ),
    );
  });

  it("rejects an instance manifest readable by group or other users", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-instances-"));
    const path = join(root, "instances.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, instances: [personalInstance()] }),
      { mode: 0o644 },
    );
    await chmod(path, 0o644);

    await expect(loadBridgeInstanceManifest(path)).rejects.toThrow(
      "Bridge instance manifest must not be accessible by group or other users",
    );
  });

  it("rejects unknown Telegram surface and actor fields", () => {
    const group = {
      type: "household-group",
      chatId: -1001234567890,
      actors: { isaac: 111, emma: 222 },
    };
    const shared = {
      id: "shared",
      principal: "household",
      telegramProfile: "shared",
      memoryView: "household",
      credentialScope: "household",
    };

    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              ...shared,
              telegramSurface: { ...group, allowedUserId: 111 },
            }),
          ],
        }),
      ),
    ).toThrow('instances[0].telegramSurface has unknown field "allowedUserId"');

    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              ...shared,
              telegramSurface: {
                ...group,
                actors: { ...group.actors, guest: 333 },
              },
            }),
          ],
        }),
      ),
    ).toThrow('instances[0].telegramSurface.actors has unknown field "guest"');
  });

  it("rejects a positive private-chat ID for the household group", () => {
    expect(() =>
      parseBridgeInstanceManifest(
        JSON.stringify({
          version: 1,
          instances: [
            personalInstance({
              id: "shared",
              principal: "household",
              telegramProfile: "shared",
              telegramSurface: {
                type: "household-group",
                chatId: 123,
                actors: { isaac: 111, emma: 222 },
              },
              memoryView: "household",
              credentialScope: "household",
            }),
          ],
        }),
      ),
    ).toThrow("instances[0].telegramSurface.chatId must be a negative safe integer");
  });

  it("derives private runtime paths from the selected instance ID", () => {
    const instance = selectBridgeInstance(
      parseBridgeInstanceManifest(
        JSON.stringify({ version: 1, instances: [personalInstance()] }),
      ),
      "isaac",
    );

    expect(
      resolveBridgeInstancePaths(instance, {
        stateRoot: "/var/lib/pi-telegram-bridge",
        configRoot: "/home/test/.config/pi-telegram-bridge",
      }),
    ).toEqual({
      stateDir: "/var/lib/pi-telegram-bridge/instances/isaac",
      sessionDir: "/var/lib/pi-telegram-bridge/instances/isaac/sessions",
      inboxPath: "/var/lib/pi-telegram-bridge/instances/isaac/inbox.db",
      codexConfigPath:
        "/var/lib/pi-telegram-bridge/instances/isaac/pi-codex-conversion.json",
      restartMarkerPath:
        "/var/lib/pi-telegram-bridge/instances/isaac/restart-pending.json",
      runtimeMetadataPath:
        "/var/lib/pi-telegram-bridge/instances/isaac/runtime.json",
      checkerStateDir: "/var/lib/pi-telegram-bridge/instances/isaac/checkers",
      environmentFilePath:
        "/home/test/.config/pi-telegram-bridge/instances/isaac.env",
    });
  });
});
