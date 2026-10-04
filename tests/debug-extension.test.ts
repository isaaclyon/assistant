import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";
import { debugEnabled } from "../src/debug-messages.js";

const store = globalThis as Record<PropertyKey, unknown>;
afterEach(() => { delete store[Symbol.for("pi-telegram-bridge.debug-state")]; delete store[Symbol.for("pi-telegram-bridge.debug-transport")]; });

it("registers a reload-safe menu toggle with explicit on/off/status and execution hooks", async () => {
  const { default: extend } = await import(new URL("../.pi/extensions/debug.ts", import.meta.url).href);
  const commands = await import(pathToFileURL(join(dirname(resolveTelegramExtensionPath()), "lib/commands.ts")).href);
  const handlers = new Map<string, (event: any) => void>();
  const pi = { on: (name: string, fn: (event: any) => void) => handlers.set(name, fn) };
  extend(pi as any); extend(pi as any);
  const command = commands.getTelegramExtensionCommands().find((item: any) => item.name === "debug");
  expect(command.showInMenu).toBe(true);
  const target = { chatId: 2, threadId: 3 };
  const reply = vi.fn(async () => {});
  const call = (args: string) => command.handler({ args, target, reply });
  await call(""); expect(debugEnabled(target)).toBe(true);
  await call("status"); expect(debugEnabled(target)).toBe(true);
  await call("bad"); expect(reply).toHaveBeenLastCalledWith("Usage: /debug [on|off|status]");
  const send = vi.fn(async (_target: unknown, _text: string) => {});
  store[Symbol.for("pi-telegram-bridge.debug-transport")] = { getActiveTarget: () => target, send };
  handlers.get("tool_execution_start")!({ toolName: "private_browser_login", toolCallId: "a", args: { password: "secret-example" } });
  handlers.get("tool_execution_end")!({ toolName: "private_browser_login", toolCallId: "a", isError: false, result: { text: "secret-example" } });
  handlers.get("tool_execution_start")!({ toolName: "search", toolCallId: "b", args: { query: "parks" } });
  handlers.get("tool_execution_end")!({ toolName: "search", toolCallId: "b", isError: true, result: { text: "unavailable" } });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(4);
  expect(send.mock.calls.map((item) => item[1]).join("\n")).not.toContain("secret-example");
  expect(send.mock.calls[3]?.[1]).toContain("Tool failed: search");
  handlers.get("agent_start")!({});
  store[Symbol.for("pi-telegram-bridge.debug-transport")] = { getActiveTarget: () => undefined, send };
  handlers.get("agent_settled")!({});
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(send.mock.calls.at(-1)?.[0]).toEqual(target);
  expect(send.mock.calls.at(-1)?.[1]).toContain("Agent settled");
  await call("off"); expect(debugEnabled(target)).toBe(false);
  await call("on"); expect(debugEnabled(target)).toBe(true);
  await call(""); expect(debugEnabled(target)).toBe(false);
});

it("patches the authorized command target and sends plain messages to the exact active topic", async () => {
  const root = dirname(resolveTelegramExtensionPath());
  expect(readFileSync(join(root, "lib/routing.ts"), "utf8")).toContain("target: sourceTarget,\n          name: command.name");
  const source = readFileSync(join(root, "index.ts"), "utf8");
  const assignment = source.match(/\(globalThis as Record<PropertyKey, unknown>\)\[Symbol.for\("pi-telegram-bridge.debug-transport"\)\] = \{[\s\S]*?\n  \};/)?.[0];
  expect(assignment).toBeDefined();
  const sendMessage = vi.fn(async () => {});
  const setup = new Function("BridgeTarget", "activeTurnRuntime", "sendMessage", assignment!.replace(" as Record<PropertyKey, unknown>", "").replace("target: { chatId: number; threadId?: number }, text: string", "target, text"));
  setup({ getOverrideTarget: () => undefined }, { getTarget: () => ({ chatId: 2, threadId: 3 }) }, sendMessage);
  const transport = store[Symbol.for("pi-telegram-bridge.debug-transport")] as any;
  await transport.send(transport.getActiveTarget(), "<b>plain</b>");
  expect(sendMessage).toHaveBeenCalledWith({ chat_id: 2, message_thread_id: 3, text: "<b>plain</b>" });
});
