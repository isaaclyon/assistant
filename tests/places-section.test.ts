import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { PlacesApplication } from "../src/places-application.js";
import { PlacesService } from "../src/places-service.js";
import { openPlacesStore } from "../src/places-store.js";
import { PlacesReply } from "../.pi/lib/places-reply.js";

it("owns text input and refuses a cancel confirmation after the comparison advances", async () => {
  const { createPlacesSection } = await import(pathToFileURL(join(process.cwd(), ".pi/lib/places-section.ts")).href);
  const dir = mkdtempSync(join(tmpdir(), "places-ui-"));
  const store = openPlacesStore(join(dir, "places.db"));
  try {
    const service = new PlacesService(store, { ownerKey: "test" });
    const application = new PlacesApplication(service);
    const replies = new PlacesReply();
    let draft: unknown;
    const section = createPlacesSection({
      getApplication: () => application, replies,
      takePendingView: () => undefined, getDraft: () => draft, setDraft: (value: unknown) => { draft = value; },
    });
    let view: { text: string; replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] } } | undefined;
    const ctx = { chatId: 42, messageId: 100, callbackData: (action: string, payload = "") => `${action}:${payload}`,
      answerCallback: vi.fn(async () => {}), open: async (value: typeof view) => { view = value; }, edit: async (value: typeof view) => { view = value; }, enqueuePrompt: vi.fn() };
    await section.handleCallback({ ...ctx, action: "add", payload: "" });
    expect(view?.text).toContain("Reply to this message");
    expect(await replies.handle({ message: { chat: { id: 42, type: "private" }, from: { id: 42 }, reply_to_message: { message_id: 101, from: { is_bot: true }, text: view!.text }, text: "Cafe" } })).toBe("consume");
    expect(draft).toEqual({ name: "Cafe" });
    expect(view?.text).toContain("Choose a category");
    expect(ctx.enqueuePrompt).not.toHaveBeenCalled();
    const oldCategory = view!.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
    await section.handleCallback({ ...ctx, action: "add", payload: "" });
    await replies.handle({ message: { chat: { id: 42, type: "private" }, from: { id: 42 }, reply_to_message: { message_id: 102, from: { is_bot: true }, text: view!.text }, text: "New draft" } });
    const [oldCategoryAction, oldCategoryPayload] = oldCategory.split(":");
    await section.handleCallback({ ...ctx, action: oldCategoryAction, payload: oldCategoryPayload });
    expect(draft).toEqual({ name: "New draft" });
    const [chooseAction, choosePayload] = view!.replyMarkup!.inline_keyboard[0]![0]!.callback_data.split(":");
    await section.handleCallback({ ...ctx, action: chooseAction, payload: choosePayload });
    const sentiments = view!.replyMarkup!.inline_keyboard[0]!;
    const [likedAction, likedPayload] = sentiments[0]!.callback_data.split(":");
    const [alrightAction, alrightPayload] = sentiments[1]!.callback_data.split(":");
    await section.handleCallback({ ...ctx, action: likedAction, payload: likedPayload });
    const beforeSibling = store.exportPublishedData();
    await section.handleCallback({ ...ctx, action: alrightAction, payload: alrightPayload });
    expect(store.exportPublishedData()).toEqual(beforeSibling);
    const categoryId = service.listCategories()[0]!.id;
    for (let i = 0; i < 4; i++) {
      let result = service.start({ name: `Place ${i}`, categoryId, sentiment: "liked" });
      while (result.kind === "compare") result = service.answer({ insertionId: result.insertionId, revision: result.revision, existingPlaceId: result.existingPlace.id, winner: "existing" });
    }
    const active = service.start({ name: "New", categoryId, sentiment: "liked" });
    if (active.kind !== "compare") throw new Error("missing comparison");
    await section.handleCallback({ ...ctx, action: "cancel", payload: active.insertionId });
    const data = view?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
    expect(data).toBeDefined();
    const next = service.answer({ insertionId: active.insertionId, revision: active.revision, existingPlaceId: active.existingPlace.id, winner: "existing" });
    expect(next.kind).toBe("compare");
    const [action, payload] = data!.split(":");
    await section.handleCallback({ ...ctx, action, payload });
    expect(service.resume()).toEqual(next);
    if (next.kind !== "compare") throw new Error("missing next comparison");
    service.cancel(next.insertionId, next.revision);
    const place = service.listRanking(categoryId)[0]!;
    await section.handleCallback({ ...ctx, action: "rerank", payload: place.id });
    const rerank = view?.replyMarkup?.inline_keyboard[2]?.[0]?.callback_data;
    expect(rerank).toBeDefined();
    const [rerankAction, rerankToken] = rerank!.split(":");
    await section.handleCallback({ ...ctx, action: rerankAction, payload: rerankToken });
    const revision = store.deletionSnapshot("place", place.id).revision;
    await section.handleCallback({ ...ctx, action: rerankAction, payload: rerankToken });
    expect(store.deletionSnapshot("place", place.id).revision).toBe(revision);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
