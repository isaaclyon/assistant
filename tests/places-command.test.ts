import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTelegramExtensionPath } from "../src/package-paths.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

interface RegisteredCommand {
  name: string;
  description?: string;
  showInMenu: boolean;
  emoji?: string;
  handler: (ctx: {
    name: string;
    args: string;
    reply: (text: string) => Promise<void>;
    enqueuePrompt: (prompt: string) => Promise<void>;
  }) => Promise<void> | void;
}

async function forkCommands() {
  const path = join(dirname(resolveTelegramExtensionPath()), "lib", "commands.ts");
  return (await import(pathToFileURL(path).href)) as {
    getTelegramExtensionCommands: () => RegisteredCommand[];
    clearTelegramExtensionCommands: () => void;
  };
}

afterEach(async () => {
  const commands = await forkCommands();
  commands.clearTelegramExtensionCommands();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("pi-telegram-bridge.command-unbind.places")
  ];
});

describe("/places command", () => {
  it("is menu-visible and queues a state-safe button flow", async () => {
    const module = (await import(
      `${pathToFileURL(join(root, ".pi", "extensions", "places.ts")).href}?command=${Date.now()}`
    )) as { default: (api: unknown) => void };
    module.default({ on: vi.fn(), registerTool: vi.fn() });
    const command = (await forkCommands())
      .getTelegramExtensionCommands()
      .find((entry) => entry.name === "places");

    expect(command).toMatchObject({ showInMenu: true, emoji: "📍" });
    const enqueuePrompt = vi.fn(async (_prompt: string) => {});
    await command?.handler({
      name: "places",
      args: "",
      reply: vi.fn(async (_text: string) => {}),
      enqueuePrompt,
    });

    expect(enqueuePrompt).toHaveBeenCalledOnce();
    const prompt = enqueuePrompt.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain('places tool with action "menu"');
    expect(prompt).toContain("telegram_button");
    expect(prompt).toContain("preserve every ID and revision exactly");
    expect(prompt).toContain("Do not claim");
  });
});
