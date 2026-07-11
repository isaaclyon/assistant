import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { startBridgeHost } from "../src/host.js";

describe("startBridgeHost", () => {
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
