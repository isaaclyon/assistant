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

async function loadSkillsExtension(): Promise<{
  default: (pi: unknown) => void;
  truncate: (desc: string, max?: number) => string;
}> {
  return (await import(
    pathToFileURL(join(root, ".pi", "extensions", "skills.ts")).href
  )) as { default: (pi: unknown) => void; truncate: (desc: string, max?: number) => string };
}

afterEach(async () => {
  const { clearTelegramExtensionCommands } = await loadForkCommands();
  clearTelegramExtensionCommands();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("pi-telegram-bridge.command-unbind.skills")
  ];
});

describe("truncate", () => {
  it("leaves short descriptions untouched, cuts long ones with an ellipsis", async () => {
    const { truncate } = await loadSkillsExtension();
    expect(truncate("short", 80)).toBe("short");
    const out = truncate("x".repeat(100), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("/skills extension", () => {
  it("registers a menu-visible skills command", async () => {
    const { default: extend } = await loadSkillsExtension();
    const { getTelegramExtensionCommands } = await loadForkCommands();

    extend({ getCommands: () => [] });

    const command = getTelegramExtensionCommands().find((c) => c.name === "skills");
    expect(command).toBeDefined();
    expect(command?.showInMenu).toBe(true);
    expect(command?.emoji).toBeTruthy();
  });

  it("replies with the skill list, sorted and truncated", async () => {
    const { default: extend } = await loadSkillsExtension();
    const { getTelegramExtensionCommands } = await loadForkCommands();

    const getCommands = () => [
      { name: "zeta", description: "last", source: "skill" },
      { name: "alpha", description: "x".repeat(200), source: "skill" },
      { name: "not-a-skill", description: "ignored", source: "extension" },
    ];
    extend({ getCommands });
    const command = getTelegramExtensionCommands().find((c) => c.name === "skills")!;

    const reply = vi.fn(async (_text: string) => {});
    await command.handler({ name: "skills", args: "", reply, enqueuePrompt: vi.fn() });

    const text = reply.mock.calls[0]?.[0] ?? "";
    expect(text.indexOf("/alpha")).toBeLessThan(text.indexOf("/zeta")); // sorted
    expect(text).not.toContain("not-a-skill"); // non-skills filtered out
    expect(text).toContain("…"); // long description truncated
  });
});
