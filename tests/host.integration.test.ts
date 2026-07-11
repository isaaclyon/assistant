import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { startBridgeHost } from "../src/host.js";
import { bindTelegramHostNewSession } from "../src/telegram-host-capability.js";

describe("startBridgeHost", () => {
  it("lets the Telegram host capability replace and rebind the persistent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-new-session-"));
    const extensionPath = join(root, "new-session-extension.mjs");
    await writeFile(
      extensionPath,
      `export default function(pi) {
        pi.registerCommand("test-ping", {
          description: "Verify extension commands are rebound after replacement",
          handler: async (_args, ctx) => {
            ctx.sessionManager.appendCustomMessageEntry("test-ping", "ok", false);
          },
        });
      }\n`,
    );
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      logger,
      telegramExtensionPath: extensionPath,
    });

    try {
      expect(() =>
        bindTelegramHostNewSession(async () => ({ cancelled: false })),
      ).toThrow(/already registered/);
      const originalSessionFile = host.runtime.session.sessionFile;
      expect(originalSessionFile).toContain(join(root, "state", "sessions"));

      const registry = (globalThis as Record<PropertyKey, unknown>)[
        Symbol.for("pi-telegram.host-capability-registry")
      ] as { provider: () => Promise<{ cancelled: boolean }> };
      await expect(registry.provider()).resolves.toEqual({ cancelled: false });

      const replacementSessionFile = host.runtime.session.sessionFile;
      expect(replacementSessionFile).toContain(join(root, "state", "sessions"));
      expect(replacementSessionFile).not.toBe(originalSessionFile);
      await expect(
        host.runtime.session.prompt("/test-ping", { source: "rpc" }),
      ).resolves.toBeUndefined();
      expect(
        host.runtime.session.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom_message" && entry.customType === "test-ping",
          ),
      ).toBe(true);
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    const unregister = bindTelegramHostNewSession(async () => ({ cancelled: false }));
    unregister();
  }, 20_000);

  it("loads pi-telegram in RPC mode with a persistent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-telegram-host-"));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const host = await startBridgeHost({
      config: {
        agentDir: join(root, "agent"),
        cwd: root,
        sessionDir: join(root, "state", "sessions"),
        stateDir: join(root, "state"),
      },
      logger,
    });

    try {
      expect(process.env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
      expect(host.runtime.session.sessionFile).toContain(
        join(root, "state", "sessions"),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Telegram is not configured"),
      );
    } finally {
      await host.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }, 20_000);
});
