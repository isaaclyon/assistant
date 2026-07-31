import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { openPlacesStore } from "../src/places-store.js";
import { resolveTelegramExtensionPath } from "../src/package-paths.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

interface ToolDefinition {
  name: string;
  promptGuidelines?: string[];
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; terminate?: boolean }>;
}

interface SectionContext {
  action: string;
  payload: string;
  callbackData: (action: string, payload?: string) => string;
  answerCallback: (text?: string) => Promise<void>;
  edit: (view: SectionView) => Promise<void>;
  enqueuePrompt: (prompt: string) => Promise<void>;
}

interface SectionView {
  text: string;
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

interface SectionRegistration {
  id: string;
  render: (ctx: SectionContext) => SectionView | Promise<SectionView>;
  handleCallback?: (ctx: SectionContext) => Promise<"handled" | "pass"> | "handled" | "pass";
}

describe("places extension", () => {
  const originalStateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;
  const originalPrincipal = process.env.PI_TELEGRAM_PRINCIPAL;
  const originalInstanceId = process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID;

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;
    else process.env.PI_TELEGRAM_BRIDGE_STATE_DIR = originalStateDir;
    if (originalPrincipal === undefined) delete process.env.PI_TELEGRAM_PRINCIPAL;
    else process.env.PI_TELEGRAM_PRINCIPAL = originalPrincipal;
    if (originalInstanceId === undefined) delete process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID;
    else process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID = originalInstanceId;
  });

  it("registers a lifecycle-owned tool with actionable results", async () => {
    const sectionsPath = join(dirname(resolveTelegramExtensionPath()), "lib", "sections.ts");
    const sections = (await import(pathToFileURL(sectionsPath).href)) as {
      createAndBindTelegramSectionRegistry: () => {
        clear(): void;
        getSections(): Array<{ id: string; registration: SectionRegistration }>;
      };
      bindTelegramSectionPresenter: (presenter: (sectionId: string) => Promise<void>) => () => void;
    };
    const sectionRegistry = sections.createAndBindTelegramSectionRegistry();
    const stateDir = await mkdtemp(join(tmpdir(), "places-extension-"));
    process.env.PI_TELEGRAM_BRIDGE_STATE_DIR = stateDir;
    process.env.PI_TELEGRAM_PRINCIPAL = "isaac";
    process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID = "isaac";
    const handlers = new Map<string, () => void>();
    let tool: ToolDefinition | undefined;
    const pi = {
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
      registerTool(definition: ToolDefinition) {
        tool = definition;
      },
    };
    const module = (await import(
      `${pathToFileURL(join(root, ".pi", "extensions", "places.ts")).href}?test=${Date.now()}`
    )) as { default: (api: unknown) => void };
    module.default(pi);

    expect(tool?.name).toBe("rank_places");
    expect(tool?.promptGuidelines?.join(" ")).toContain("telegram_button");
    handlers.get("session_start")?.();
    const section = sectionRegistry.getSections().find((entry) => entry.id === "assistant/place-rankings")?.registration;
    if (!section) throw new Error("missing places section");
    let presentedView: SectionView | undefined;
    const callbackData = (action: string, payload?: string) => `section:0:${action}${payload ? `:${payload}` : ""}`;
    const baseContext: SectionContext = {
      action: "",
      payload: "",
      callbackData,
      answerCallback: async () => {},
      edit: async (view) => {
        presentedView = view;
      },
      enqueuePrompt: async () => {},
    };
    const unbindPresenter = sections.bindTelegramSectionPresenter(async () => {
      presentedView = await section.render(baseContext);
    });
    const menu = await tool?.execute("call-1", { action: "menu" });
    expect(menu?.details).toMatchObject({
      ok: true,
      result: { categories: expect.arrayContaining([expect.objectContaining({ name: "Coffee" })]) },
    });
    expect(menu?.details).toMatchObject({
      result: { buttonActions: expect.arrayContaining([
        expect.objectContaining({ label: "Add place" }),
        expect.objectContaining({ label: "Manage places" }),
        expect.objectContaining({ label: "New category" }),
      ]) },
    });
    const categoryId = (
      menu?.details as {
        result?: { categories?: Array<{ id?: string }> };
      }
    ).result?.categories?.[0]?.id;
    if (!categoryId) throw new Error("missing category");
    const directCategories = await tool?.execute("call-direct-categories", {
      action: "categories",
      name: "Direct Place",
    });
    expect(directCategories?.terminate).toBe(true);
    expect(presentedView?.text).toContain("Choose a category");
    await section.handleCallback?.({ ...baseContext, action: "category", payload: categoryId });
    expect(presentedView?.text).toContain("overall impression");
    await section.handleCallback?.({ ...baseContext, action: "sentiment", payload: "disliked" });
    expect(presentedView?.text).toContain("Ranked Direct Place");
    expect(presentedView?.text).toContain("#1 of 1 in Restaurants");
    const first = await tool?.execute("call-first", {
      action: "start",
      name: "Existing",
      category_id: categoryId,
      sentiment: "liked",
    });
    expect(first?.details).toMatchObject({ result: { buttonActions: expect.arrayContaining([expect.objectContaining({ label: "Add notes" })]) } });
    const duplicate = await tool?.execute("call-duplicate", {
      action: "start",
      name: " existing ",
      category_id: categoryId,
      sentiment: "liked",
    });
    expect(duplicate?.details).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_PLACE" },
      buttonActions: expect.arrayContaining([expect.objectContaining({ label: "View existing" })]),
    });
    const comparison = await tool?.execute("call-second", {
      action: "start",
      name: "Candidate",
      category_id: categoryId,
      sentiment: "liked",
    });
    expect(comparison?.details).toMatchObject({
      ok: true,
      result: {
        kind: "compare",
        buttonActions: [
          expect.objectContaining({ label: "Candidate", prompt: expect.stringContaining("revision 0") }),
          expect.objectContaining({ label: "Existing", prompt: expect.stringContaining('winner "existing"') }),
          expect.objectContaining({ label: "Cancel", prompt: expect.stringContaining("operation-bound") }),
        ],
      },
    });
    expect(comparison?.terminate).toBe(true);
    expect(presentedView?.text).toContain("Which is better?");
    expect(presentedView?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data)
      .toMatch(/^section:0:direct:/u);
    expect((comparison?.details as { result?: { buttonActions?: Array<{ label: string }> } }).result?.buttonActions)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ label: "Back" })]));
    const comparisonValue = (comparison?.details as {
      result?: { insertionId?: string; revision?: number; existingPlace?: { id?: string } };
    }).result;
    if (!comparisonValue?.insertionId || comparisonValue.revision === undefined) throw new Error("missing comparison state");
    const staleWhileActive = await tool?.execute("call-stale-active", {
      action: "answer",
      insertion_id: comparisonValue.insertionId,
      revision: comparisonValue.revision + 1,
      existing_place_id: comparisonValue.existingPlace?.id,
      winner: "candidate",
    });
    expect(staleWhileActive?.details).toMatchObject({
      ok: true,
      result: { kind: "stale", current: { kind: "compare", revision: comparisonValue.revision } },
    });
    const confirmation = await tool?.execute("call-confirm", {
      action: "request_confirmation",
      confirmation_operation: "cancel",
      insertion_id: comparisonValue.insertionId,
      revision: comparisonValue.revision,
    });
    const stillActive = await tool?.execute("call-decline", { action: "resume" });
    expect(stillActive?.details).toMatchObject({ ok: true, result: { kind: "compare", insertionId: comparisonValue.insertionId } });
    const confirmationPrompt = (confirmation?.details as { result?: { buttonActions?: Array<{ prompt?: string }> } }).result?.buttonActions?.[0]?.prompt ?? "";
    const token = /confirmation_token "([^"]+)"/u.exec(confirmationPrompt)?.[1];
    if (!token) throw new Error("missing confirmation token");
    const cancelled = await tool?.execute("call-cancel", {
      action: "cancel",
      insertion_id: comparisonValue.insertionId,
      revision: comparisonValue.revision,
      confirmation_token: token,
    });
    expect(cancelled?.details).toMatchObject({ ok: true, result: { cancelled: true } });
    const replay = await tool?.execute("call-replay", {
      action: "cancel",
      insertion_id: comparisonValue.insertionId,
      revision: comparisonValue.revision,
      confirmation_token: token,
    });
    expect(replay?.details).toMatchObject({ ok: false, error: { code: "INVALID_ACTION" } });
    const stale = await tool?.execute("call-stale", {
      action: "answer",
      insertion_id: comparisonValue.insertionId,
      revision: comparisonValue.revision,
      existing_place_id: comparisonValue.existingPlace?.id,
      winner: "candidate",
    });
    expect(stale?.details).toMatchObject({ ok: true, result: { kind: "stale", current: null, restartRequired: true } });

    const pagingStore = openPlacesStore(join(stateDir, "places.db"));
    const pagingCategory = pagingStore.createCategory("Paging", "Paging", 10);
    for (let index = 0; index < 26; index += 1) {
      pagingStore.insertPlace({ id: `page-${index}`, categoryId: pagingCategory.id, name: `Place ${index}`, sentiment: "liked", index, now: 20 + index });
    }
    pagingStore.close();
    const firstPage = await tool?.execute("call-page", { action: "ranking", category_id: pagingCategory.id, limit: 25 });
    expect(firstPage?.details).toMatchObject({
      ok: true,
      result: {
        hasPrevious: false,
        hasNext: true,
        places: expect.arrayContaining([expect.objectContaining({ name: "Place 0" })]),
        buttonActions: expect.arrayContaining([expect.objectContaining({ label: "Next", prompt: expect.stringContaining("offset 25") })]),
      },
    });
    const deniedDelete = await tool?.execute("call-denied", {
      action: "delete_place",
      place_id: "missing",
    });
    expect(deniedDelete?.details).toMatchObject({ ok: false, error: { code: "INVALID_ACTION" } });
    const invalid = await tool?.execute("call-2", { action: "start" });
    expect(invalid?.details).toMatchObject({
      ok: false,
      error: { code: "INVALID_ACTION" },
    });
    handlers.get("session_shutdown")?.();
    const unavailable = await tool?.execute("call-3", { action: "menu" });
    expect(unavailable?.details).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    process.env.PI_TELEGRAM_PRINCIPAL = "emma";
    handlers.get("session_start")?.();
    const wrongPrincipal = await tool?.execute("call-4", { action: "menu" });
    expect(wrongPrincipal?.details).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    process.env.PI_TELEGRAM_PRINCIPAL = "isaac";
    delete process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID;
    handlers.get("session_start")?.();
    const singleton = await tool?.execute("call-5", { action: "menu" });
    expect(singleton?.details).toMatchObject({ ok: true });
    await rm(stateDir, { recursive: true, force: true });
    unbindPresenter();
    sectionRegistry.clear();
  });
});
