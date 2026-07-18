import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function loadReloadExtension(): Promise<(pi: unknown) => void> {
  const mod = (await import(
    pathToFileURL(join(root, ".pi", "extensions", "reload.ts")).href
  )) as { default: (pi: unknown) => void };
  return mod.default;
}

afterEach(async () => {
  const { clearTelegramExtensionCommands } = await loadForkCommands();
  clearTelegramExtensionCommands();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("pi-telegram-bridge.command-unbind.reload")
  ];
});

describe("/reload extension", () => {
  it("registers a menu-visible command that forwards Pi's built-in /reload", async () => {
    const extend = await loadReloadExtension();
    const { getTelegramExtensionCommands } = await loadForkCommands();

    extend({});
    const command = getTelegramExtensionCommands().find((c) => c.name === "reload");
    expect(command).toBeDefined();
    expect(command?.showInMenu).toBe(true);
    expect(command?.emoji).toBeTruthy();

    const enqueuePrompt = vi.fn(async (_prompt: string) => {});
    await command?.handler({
      name: "reload",
      args: "",
      reply: vi.fn(),
      enqueuePrompt,
    });

    expect(enqueuePrompt).toHaveBeenCalledWith("/reload");
  });
});
