import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
interface View { text: string; replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }
interface Context {
  chatId: number; action: string; payload: string;
  callbackData(action: string, payload: string): string;
  answerCallback(): Promise<void>; edit(view: View): Promise<void>;
}
interface Section { render(ctx: Context): View; handleCallback(ctx: Context): Promise<string> }
interface Tool {
  parameters: unknown;
  execute(id: string, params: Record<string, unknown>): Promise<{ details: { ok: boolean; result?: Record<string, unknown>; error?: { code: string } } }>;
}

it("exposes typed CRUD and user-only, single-use confirmation callbacks with no token in tool results", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "memory-extension-")); roots.push(sandbox);
  for (const [key, value] of Object.entries({
    PI_TELEGRAM_BRIDGE_INSTANCE_ID: "isaac", PI_TELEGRAM_PRINCIPAL: "isaac",
    PI_TELEGRAM_MEMORY_VIEW: "owner-and-household", PI_TELEGRAM_MEMORY_DIR: join(sandbox, "vault"),
    PI_TELEGRAM_BRIDGE_STATE_DIR: join(sandbox, "state"), PI_TELEGRAM_BRIDGE_RESOURCE_ROOT: root,
    PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT: "0", PI_TELEGRAM_OPENAI_API_KEY_FILE: "",
  })) vi.stubEnv(key, value);
  const sections = await import(pathToFileURL(join(dirname(resolveTelegramExtensionPath()), "lib/sections.ts")).href) as {
    createAndBindTelegramSectionRegistry(): { clear(): void; getSections(): Array<{ registration: Section }> };
    bindTelegramSectionPresenter(fn: (id: string) => Promise<void>): () => void;
  };
  const registry = sections.createAndBindTelegramSectionRegistry();
  const handlers = new Map<string, () => void>();
  let tool!: Tool;
  let presented!: View;
  const ctx: Context = { chatId: 11, action: "", payload: "", callbackData: (action, token) => `${action}:${token}`,
    answerCallback: async () => {}, edit: async (view) => { presented = view; } };
  let deliveryFails = false;
  const unbind = sections.bindTelegramSectionPresenter(async () => {
    presented = registry.getSections()[0]!.registration.render(ctx);
    if (deliveryFails) throw new Error("Synthetic send failure");
  });
  try {
    const module = await import(pathToFileURL(join(root, ".pi/extensions/memory.ts")).href) as { default(pi: unknown): void };
    module.default({ on: (event: string, handler: () => void) => handlers.set(event, handler), registerTool: (value: Tool) => { tool = value; } });
    const call = async (params: Record<string, unknown>) => (await tool.execute("test", params)).details;
    expect((await call({ action: "read", id: "anything" })).ok).toBe(false);
    handlers.get("session_start")!();
    const preparation = await call({ action: "prepare_create", type: "preference", title: "Dining", body: "Quiet restaurants." });
    expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true });
    const draft = preparation.result!;
    const added = (await call({ action: "create", creationToken: draft.creationToken })).result!;
    expect((await call({ action: "read", id: added.id })).result!.body).toBe("Quiet restaurants.");
    const pending = await call({ action: "request_share", id: added.id, ifRevision: added.revision });
    expect(pending.result).toMatchObject({ status: "awaiting_confirmation" });
    const button = presented.replyMarkup!.inline_keyboard[0]![0]!;
    const [action, token] = button.callback_data.split(":");
    expect(button.text).toBe("Confirm sharing");
    expect(JSON.stringify(pending)).not.toContain(token);
    expect((await call({ action: "read", id: added.id })).result!.scope).toBe("personal");
    const section = registry.getSections()[0]!.registration;
    await section.handleCallback({ ...ctx, chatId: 22, action: action!, payload: token! });
    expect((await call({ action: "read", id: added.id })).result!.scope).toBe("personal");
    await section.handleCallback({ ...ctx, action: action!, payload: token! });
    expect(presented.text).toBe("Memory shared with the household.");
    const shared = (await call({ action: "read", id: added.id })).result!;
    expect(shared.scope).toBe("household");
    await section.handleCallback({ ...ctx, action: action!, payload: token! });
    expect(presented.text).toContain("expired");

    deliveryFails = true;
    expect((await call({ action: "request_delete", id: shared.id, ifRevision: shared.revision })).ok).toBe(false);
    const failedToken = presented.replyMarkup!.inline_keyboard[0]![0]!.callback_data.split(":")[1]!;
    await section.handleCallback({ ...ctx, action: "confirm", payload: failedToken });
    expect((await call({ action: "read", id: added.id })).ok).toBe(true);
    deliveryFails = false;
    await call({ action: "request_delete", id: shared.id, ifRevision: shared.revision });
    const deleteToken = presented.replyMarkup!.inline_keyboard[0]![0]!.callback_data.split(":")[1]!;
    handlers.get("session_shutdown")!();
    handlers.get("session_start")!();
    await registry.getSections()[0]!.registration.handleCallback({ ...ctx, action: "confirm", payload: deleteToken });
    expect((await call({ action: "read", id: added.id })).ok).toBe(true);
    expect(JSON.stringify(tool.parameters)).not.toContain('"confirmationToken"');
  } finally {
    handlers.get("session_shutdown")?.(); unbind(); registry.clear();
  }
});
