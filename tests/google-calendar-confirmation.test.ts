import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

interface View { text: string; replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }
interface Context {
  chatId: number; action: string; payload: string;
  callbackData(action: string, payload: string): string;
  answerCallback(): Promise<void>; edit(view: View): Promise<void>;
}
interface Section { render(ctx: Context): View; handleCallback(ctx: Context): Promise<string> }
interface Tool { parameters: unknown; execute(id: string, input: Record<string, unknown>): Promise<{ details: { ok: boolean; result?: unknown } }> }

it("keeps approval in direct Telegram callbacks, discards failed deliveries and clears old sessions", async () => {
  vi.stubEnv("PI_TELEGRAM_BRIDGE_INSTANCE_ID", "isaac");
  const sections = await import(pathToFileURL(join(dirname(resolveTelegramExtensionPath()), "lib/sections.ts")).href) as {
    createAndBindTelegramSectionRegistry(): { clear(): void; getSections(): Array<{ registration: Section }> };
    bindTelegramSectionPresenter(fn: (id: string) => Promise<void>): () => void;
  };
  const registry = sections.createAndBindTelegramSectionRegistry();
  const handlers = new Map<string, () => void>();
  let tool!: Tool; let presented!: View; let failDelivery = false; let deletes = 0;
  const ctx: Context = { chatId: 11, action: "", payload: "", callbackData: (action, token) => `${action}:${token}`,
    answerCallback: async () => {}, edit: async view => { presented = view; } };
  const unbind = sections.bindTelegramSectionPresenter(async () => {
    presented = registry.getSections()[0]!.registration.render(ctx);
    if (failDelivery) throw new Error("Synthetic delivery failure");
  });
  try {
    const module = await import(pathToFileURL(join(import.meta.dirname, "../.pi/extensions/google-workspace.ts")).href);
    module.registerGoogleWorkspaceTool({ on: (name: string, fn: () => void) => handlers.set(name, fn), registerTool: (value: Tool) => { tool = value; } }, {
      resolveRuntime: async () => ({ calendarWrites: { account: "owner@example.com", personal: "personal-id", thingsToDo: "todo-id" } }),
      run: async (_runtime: unknown, args: string[]) => {
        if (args.includes("calendar.calendarList.get")) return { id: "personal-id", accessRole: "owner" };
        if (args.includes("calendar.events.get")) return { id: "event1", etag: '"v1"', summary: "Synthetic event", start: { date: "2026-10-01" }, end: { date: "2026-10-02" } };
        if (args.includes("calendar.events.delete")) { deletes += 1; return {}; }
        throw new Error("Unexpected call");
      },
    });
    const request = async () => (await tool.execute("test", { operation: "calendar_request_delete", event_id: "event1", if_etag: '"v1"' })).details;
    expect((await request()).ok).toBe(false);
    handlers.get("session_start")!();
    const result = await request(); expect(result.ok).toBe(true); expect(deletes).toBe(0);
    const token = () => presented.replyMarkup!.inline_keyboard[0]![0]!.callback_data.split(":")[1]!;
    const firstToken = token();
    expect(JSON.stringify(result)).not.toContain(firstToken);
    expect(presented.text).toContain("Synthetic event"); expect(presented.text).toContain("2026-10-01");
    const callback = (payload: string, chatId = 11, action = "confirm") => registry.getSections()[0]!.registration.handleCallback({ ...ctx, payload, chatId, action });
    await callback(firstToken, 22); expect(deletes).toBe(0);
    await callback(firstToken); expect(deletes).toBe(1); expect(presented.text).toBe("Event deleted.");
    await callback(firstToken); expect(deletes).toBe(1);
    failDelivery = true; expect((await request()).ok).toBe(false);
    await callback(token()); expect(deletes).toBe(1);
    failDelivery = false; await request(); const oldToken = token();
    handlers.get("session_shutdown")!(); handlers.get("session_start")!();
    await callback(oldToken); expect(deletes).toBe(1);
    await request(); await callback(token(), 11, "cancel"); expect(deletes).toBe(1);
    expect((await tool.execute("test", { operation: "calendar_confirm_delete", token: firstToken })).details.ok).toBe(false);
    expect(JSON.stringify(tool.parameters)).not.toContain("confirmation_token");
  } finally { handlers.get("session_shutdown")?.(); unbind(); registry.clear(); vi.unstubAllEnvs(); }
});
