import { readFile } from "node:fs/promises";
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
    openSection: (sectionId: string) => Promise<void>;
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
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("pi-telegram-bridge.command-unbind.place_rankings")
  ];
});

describe("/place_rankings command", () => {
  it("replaces /places and opens the renamed direct rankings section", async () => {
    const extensionPath = join(root, ".pi", "extensions", "places.ts");
    const module = (await import(
      `${pathToFileURL(extensionPath).href}?command=${Date.now()}`
    )) as { default: (api: unknown) => void };
    module.default({ on: vi.fn(), registerTool: vi.fn() });
    const registered = (await forkCommands()).getTelegramExtensionCommands();
    const command = registered.find((entry) => entry.name === "place_rankings");

    expect(command).toMatchObject({ showInMenu: true, emoji: "📍" });
    expect(registered.some((entry) => entry.name === "places")).toBe(false);
    const enqueuePrompt = vi.fn(async (_prompt: string) => {});
    const openSection = vi.fn(async (_sectionId: string) => {});
    await command?.handler({
      name: "place_rankings",
      args: "",
      reply: vi.fn(async (_text: string) => {}),
      openSection,
      enqueuePrompt,
    });

    expect(openSection).toHaveBeenCalledWith("assistant/place-rankings");
    expect(enqueuePrompt).not.toHaveBeenCalled();
    expect(await readFile(extensionPath, "utf8")).not.toMatch(/\bcall(?:ing)? places\b/i);
  });
});
