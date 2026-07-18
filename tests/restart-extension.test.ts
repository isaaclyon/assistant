import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindBridgeRestart } from "../src/telegram-capabilities.js";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

type TelegramCommandCtx = {
  name: string;
  args: string;
  reply: (text: string) => Promise<void>;
  enqueuePrompt: (prompt: string) => Promise<void>;
};

type RegisteredCommand = {
  name: string;
  description?: string;
  showInMenu: boolean;
  emoji?: string;
  handler: (ctx: TelegramCommandCtx) => Promise<void> | void;
};

async function loadForkCommands(): Promise<{
  getTelegramExtensionCommands: () => RegisteredCommand[];
  clearTelegramExtensionCommands: () => void;
}> {
  const path = join(dirname(resolveTelegramExtensionPath()), "lib", "commands.ts");
  return (await import(pathToFileURL(path).href)) as {
    getTelegramExtensionCommands: () => RegisteredCommand[];
    clearTelegramExtensionCommands: () => void;
  };
}

async function loadRestartExtension(): Promise<(pi: unknown) => void> {
  const mod = (await import(
    pathToFileURL(join(root, ".pi", "extensions", "restart.ts")).href
  )) as { default: (pi: unknown) => void };
  return mod.default;
}

const UNBIND_KEY = Symbol.for("pi-telegram-bridge.restart-command-unbind");

afterEach(async () => {
  const { clearTelegramExtensionCommands } = await loadForkCommands();
  clearTelegramExtensionCommands();
  delete (globalThis as Record<PropertyKey, unknown>)[UNBIND_KEY];
});

describe("/restart extension", () => {
  it("registers a menu-visible restart command", async () => {
    const extend = await loadRestartExtension();
    const { getTelegramExtensionCommands } = await loadForkCommands();

    extend({});

    const command = getTelegramExtensionCommands().find((c) => c.name === "restart");
    expect(command).toBeDefined();
    expect(command?.showInMenu).toBe(true);
    expect(command?.emoji).toBeTruthy();
    expect(command?.description).toContain("Restart");
  });

  it("replies then triggers the bound restart capability", async () => {
    const restart = vi.fn();
    const unbind = bindBridgeRestart(restart);
    try {
      const extend = await loadRestartExtension();
      const { getTelegramExtensionCommands } = await loadForkCommands();
      extend({});
      const command = getTelegramExtensionCommands().find((c) => c.name === "restart")!;

      const reply = vi.fn(async (_text: string) => {});
      await command.handler({ name: "restart", args: "", reply, enqueuePrompt: vi.fn() });

      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]?.[0]).toMatch(/restart/i);
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      unbind();
    }
  });

  it("reports unavailability instead of throwing when the capability is unbound", async () => {
    const extend = await loadRestartExtension();
    const { getTelegramExtensionCommands } = await loadForkCommands();
    extend({});
    const command = getTelegramExtensionCommands().find((c) => c.name === "restart")!;

    const reply = vi.fn(async (_text: string) => {});
    await command.handler({ name: "restart", args: "", reply, enqueuePrompt: vi.fn() });
    expect(reply.mock.calls[0]?.[0]).toMatch(/unavailable/i);
  });

  it("re-registers cleanly on reload (factory re-run) without duplicating", async () => {
    const extend = await loadRestartExtension();
    const { getTelegramExtensionCommands } = await loadForkCommands();

    extend({});
    expect(() => extend({})).not.toThrow();

    const matches = getTelegramExtensionCommands().filter((c) => c.name === "restart");
    expect(matches).toHaveLength(1);
  });
});
