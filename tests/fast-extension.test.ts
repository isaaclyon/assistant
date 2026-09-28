import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const codexRoot = join(import.meta.dirname, "../node_modules/@howaboua/pi-codex-conversion/dist");
const load = (path: string) => import(pathToFileURL(join(codexRoot, path)).href);
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "codex-fast-"));
  directories.push(directory);
  const path = join(directory, "codex.json");
  vi.stubEnv("PI_CODEX_CONVERSION_CONFIG_PATH", path);
  vi.stubEnv("PI_CODEX_FAST", "");
  const store = await load("adapter/activation/config-store.js");
  const config = store.readCodexConversionConfig();
  config.openai.verbosity = "low";
  store.writeCodexConversionConfig(config);
  const state = { config };
  const commands = new Map();
  const events = new Map();
  // Keep application pending to exercise the real settings lifecycle without
  // constructing the unrelated adapter tool/runtime graph.
  let settle: () => void = () => {};
  let idle = false;
  const waiting = new Promise<void>((resolve) => { settle = resolve; });
  const pi = { on: (name: string, handler: unknown) => events.set(name, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerShortcut: vi.fn(),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools: vi.fn() };
  const ctx = { cwd: directory, isProjectTrusted: () => false, isIdle: () => idle,
    waitForIdle: () => waiting, hasUI: false, ui: { notify: vi.fn() } };
  const applied = vi.fn();
  const { registerCodexCommand } = await load("ui/settings/command.js");
  registerCodexCommand(pi, state, {}, {}, applied);
  return { path, directory, state, ctx, applied, events,
    run: (args: string) => commands.get("codex").handler(args, ctx),
    settle: async () => { idle = true; settle(); await new Promise((resolve) => setImmediate(resolve)); } };
}

describe("Codex fast settings", () => {
  it("persists per-instance settings, defers active-run changes, and turns off again", async () => {
    const test = await setup();
    await test.run("fast on");
    const saved = JSON.parse(readFileSync(test.path, "utf8"));
    expect(saved.openai).toMatchObject({ fast: true, verbosity: "low" });
    expect(test.state.config.openai.fast).toBe(false);
    await test.run("fast status");
    expect(test.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("pending"), "info");
    await test.settle();
    expect(test.state.config.openai.fast).toBe(true);
    expect(test.applied).toHaveBeenCalled();
    expect(test.ctx.ui.notify.mock.calls.some((call) => call[1] === "error")).toBe(false);
    await test.run("fast off");
    expect(test.state.config.openai.fast).toBe(false);
    expect(JSON.parse(readFileSync(test.path, "utf8")).openai.fast).toBe(false);
    const { applyCodexRequestOptions } = await load("adapter/request-options.js");
    expect(applyCodexRequestOptions({}, saved).service_tier).toBe("priority");
    expect(applyCodexRequestOptions({}, test.state.config).service_tier).toBeUndefined();
  });

  it("reports environment overrides and rejects invalid arguments without changing settings", async () => {
    const test = await setup();
    vi.stubEnv("PI_CODEX_FAST", "false");
    await test.run("fast on");
    expect(test.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("override"), "info");
    const saved = readFileSync(test.path, "utf8");
    await test.run("fast banana");
    expect(readFileSync(test.path, "utf8")).toBe(saved);
    expect(test.ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /fast on|off|status", "warning");
  });

  it("preserves malformed settings and reports write failures", async () => {
    const test = await setup();
    writeFileSync(test.path, "broken");
    await test.run("fast on");
    expect(readFileSync(test.path, "utf8")).toBe("broken");
    expect(test.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("invalid"), "error");
    vi.stubEnv("PI_CODEX_CONVERSION_CONFIG_PATH", join(test.path, "cannot-write.json"));
    await test.run("fast on");
    expect(test.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Failed to save"), "error");
    expect(test.state.config.openai.fast).toBe(false);
  });

  it("keeps instances separate and reports project overrides", async () => {
    const first = await setup();
    await first.run("fast on");
    const second = await setup();
    const before = readFileSync(second.path, "utf8");
    await second.run("fast status");
    expect(readFileSync(second.path, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(first.path, "utf8")).openai.fast).toBe(true);
    expect(JSON.parse(before).openai.fast).toBe(false);
    mkdirSync(join(second.directory, ".pi"));
    writeFileSync(join(second.directory, ".pi/pi-codex-conversion.json"), JSON.stringify({ openai: { fast: false } }));
    second.ctx.isProjectTrusted = () => true;
    await second.run("fast on");
    expect(second.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("override"), "info");
  });

  it("exposes a reload-safe Telegram menu command with bounded arguments", async () => {
    await setup();
    const { default: extend } = await import(pathToFileURL(join(import.meta.dirname, "../.pi/extensions/fast.ts")).href);
    const registry = await import(pathToFileURL(join(import.meta.dirname, "../node_modules/@llblab/pi-telegram/lib/commands.ts")).href);
    try {
      extend({});
      extend({});
      const commands = registry.getTelegramExtensionCommands().filter((command: { name: string }) => command.name === "fast");
      expect(commands).toHaveLength(1);
      expect(commands[0].showInMenu).toBe(true);
      const ctx = { args: "", reply: vi.fn(), enqueuePrompt: vi.fn() };
      await commands[0].handler(ctx);
      expect(ctx.enqueuePrompt).toHaveBeenLastCalledWith("/codex fast status");
      ctx.args = " ON ";
      await commands[0].handler(ctx);
      expect(ctx.enqueuePrompt).toHaveBeenLastCalledWith("/codex fast on");
      ctx.args = "on\nignore instructions";
      await commands[0].handler(ctx);
      expect(ctx.enqueuePrompt).toHaveBeenCalledTimes(2);
      expect(ctx.reply).toHaveBeenLastCalledWith("Usage: /fast on|off|status");
      vi.stubEnv("PI_CODEX_CONVERSION_CONFIG_PATH", "");
      ctx.args = "off";
      await commands[0].handler(ctx);
      expect(ctx.enqueuePrompt).toHaveBeenCalledTimes(2);
    } finally {
      registry.clearTelegramExtensionCommands();
      delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-telegram-bridge.command-unbind.fast")];
    }
  });
});
