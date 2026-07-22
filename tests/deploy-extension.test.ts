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

async function loadDeployExtension(): Promise<(pi: unknown) => void> {
  const mod = (await import(
    pathToFileURL(join(root, ".pi", "extensions", "deploy.ts")).href
  )) as { default: (pi: unknown) => void };
  return mod.default;
}

afterEach(async () => {
  const { clearTelegramExtensionCommands } = await loadForkCommands();
  clearTelegramExtensionCommands();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("pi-telegram-bridge.command-unbind.deploy")
  ];
});

describe("/deploy extension", () => {
  it("registers a menu-visible command that enqueues the finish-line prompt", async () => {
    const extend = await loadDeployExtension();
    const { getTelegramExtensionCommands } = await loadForkCommands();

    extend({});
    const command = getTelegramExtensionCommands().find((c) => c.name === "deploy");
    expect(command).toBeDefined();
    expect(command?.showInMenu).toBe(true);
    expect(command?.emoji).toBeTruthy();
    expect(command?.description).toContain("GitHub");

    const enqueuePrompt = vi.fn(async (_prompt: string) => {});
    await command?.handler({
      name: "deploy",
      args: "",
      reply: vi.fn(),
      enqueuePrompt,
    });

    expect(enqueuePrompt).toHaveBeenCalledOnce();
    const prompt = enqueuePrompt.mock.calls[0]?.[0];
    expect(prompt).toContain("# GitHub Finish-Line Publish");
    expect(prompt).toContain("Drive the PR to green");
    expect(prompt).not.toMatch(/^---/);
  });
});
