import { randomUUID } from "node:crypto";
import type { TelegramSectionCallbackContext, TelegramSectionContext, TelegramSectionView } from "@llblab/pi-telegram/sections";
import { PlacesServiceError } from "../../src/places-service.ts";
import { PlacesApplication, type PlacesCommand } from "../../src/places-application.ts";
import type { PlacesReply } from "./places-reply.ts";
export const PLACE_RANKINGS_SECTION_ID = "assistant/place-rankings";
type AddDraft = { name: string; categoryId?: string };
export type DirectAction =
  | { kind: "answer"; insertionId: string; revision: number; existingPlaceId: string; winner: "candidate" | "existing" }
  | { kind: "back"; insertionId: string; revision: number }
  | { kind: "command"; command: PlacesCommand }
  | { kind: "category"; draft: AddDraft; value: string }
  | { kind: "sentiment"; draft: AddDraft; value: string };
export type DirectPendingView = { kind: "categories" } | { kind: "result"; value: unknown };

export function createPlacesSection(deps: {
  getApplication: () => PlacesApplication | undefined;
  replies: PlacesReply;
  takePendingView: () => DirectPendingView | undefined;
  getDraft: () => { name: string; categoryId?: string } | undefined;
  setDraft: (draft: { name: string; categoryId?: string } | undefined) => void;
}) {
  const actions = new Map<string, { action: DirectAction; expiresAt: number }>();
  const registerAction = (action: DirectAction): string => {
    const token = randomUUID();
    actions.set(token, { action, expiresAt: Date.now() + 10 * 60_000 });
    if (actions.size > 128) actions.delete(actions.keys().next().value!);
    return token;
  };
  const takeAction = (token: string): DirectAction | undefined => {
    const value = actions.get(token);
    actions.delete(token);
    return value && value.expiresAt > Date.now() ? value.action : undefined;
  };
  const execute = (command: PlacesCommand) => {
    const app = deps.getApplication();
    if (!app) throw new Error("Places is unavailable.");
    return app.execute(command);
  };
  const commandButton = (ctx: TelegramSectionContext, text: string, command: PlacesCommand) => ({
    text, callback_data: ctx.callbackData("direct", registerAction({ kind: "command", command })),
  });
  const ask = async (ctx: TelegramSectionCallbackContext, label: string, receive: (text: string) => TelegramSectionView) => {
    // Each standalone prompt has a unique body. The public open() port returns
    // no message ID; bind the reply's exact bot-message body, private actor/chat,
    // and a message ID newer than the authorized callback instead.
    const promptText = `Reply to this message with ${label}. This input expires in 10 minutes.\n\nInput reference: ${randomUUID()}`;
    deps.replies.arm(ctx, async (text) => {
      try { await ctx.edit(receive(text)); }
      catch (error) {
        await ctx.edit({ ...placesMenuView(ctx), text: escapeHtml(error instanceof PlacesServiceError ? error.message : "Unable to finish that action. Open /place_rankings to inspect the current state.") });
      }
    }, promptText);
    try {
      await ctx.open({ text: promptText, parseMode: "plain",
        replyMarkup: { inline_keyboard: [[{ text: "Cancel input", callback_data: ctx.callbackData("menu") }]] } });
    } catch (error) { deps.replies.clear(); throw error; }
    await ctx.answerCallback();
  };
  const requireApplication = (): PlacesApplication => {
    const current = deps.getApplication();
    if (!current) throw new Error("Places is unavailable.");
    return current;
  };
  const render = (ctx: TelegramSectionContext): TelegramSectionView => {
    const current = requireApplication();
    const pending = deps.takePendingView();
    if (pending?.kind === "categories") {
      return categoryPickerView(current, ctx, registerAction, deps.getDraft());
    }
    if (pending?.kind === "result") {
      return directResultView(current, pending.value, ctx, registerAction);
    }
    try {
      return directResultView(current, current.execute({ action: "resume" }), ctx, registerAction);
    } catch (error) {
      if (!(error instanceof PlacesServiceError) || error.code !== "NO_ACTIVE_INSERTION") {
        throw error;
      }
      return placesMenuView(ctx);
    }
  };

  return {
    id: PLACE_RANKINGS_SECTION_ID,
    label: "📍 Place Rankings",
    order: 20,
    render,
    handleCallback: async (ctx: TelegramSectionCallbackContext) => {
      deps.replies.clear();
      const current = requireApplication();
      try {
      switch (ctx.action) {
        case "menu":
          await ctx.edit(placesMenuView(ctx));
          await ctx.answerCallback();
          return "handled" as const;
        case "add":
          deps.setDraft(undefined);
          await ask(ctx, "the place name", (name) => {
            if (!name.trim() || name.length > 200) throw new PlacesServiceError("INVALID_ACTION", "Use a name between 1 and 200 characters.");
            deps.setDraft({ name });
            return categoryPickerView(current, ctx, registerAction, deps.getDraft());
          });
          return "handled" as const;
        case "new-category":
          await ask(ctx, "the new category name", (name) => {
            execute({ action: "create_category", name });
            return deps.getDraft() ? categoryPickerView(current, ctx, registerAction, deps.getDraft()) : categorySummariesView(current, ctx);
          });
          return "handled" as const;
        case "summaries":
          await ctx.edit(categorySummariesView(current, ctx));
          await ctx.answerCallback();
          return "handled" as const;
        case "rank":
          await ctx.edit(rankingView(current, ctx.payload, 0, 25, ctx));
          await ctx.answerCallback();
          return "handled" as const;
        case "page": {
          const [categoryId, rawOffset] = ctx.payload.split(",");
          const offset = Number(rawOffset);
          if (!categoryId || !Number.isSafeInteger(offset) || offset < 0) {
            await ctx.answerCallback("That page is invalid.");
            return "handled" as const;
          }
          await ctx.edit(rankingView(current, categoryId, offset, 25, ctx));
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "place":
          await ctx.edit(placeView(current, ctx.payload, ctx));
          await ctx.answerCallback();
          return "handled" as const;
        case "category":
        case "sentiment":
          await ctx.answerCallback("This button expired. Open /place_rankings again.");
          return "handled" as const;
        case "direct": {
          const action = takeAction(ctx.payload);
          if (!action) {
            await ctx.answerCallback("This button expired. Open /place_rankings again.");
            return "handled" as const;
          }
          if (action.kind === "category" || action.kind === "sentiment") {
            if (deps.getDraft() !== action.draft) {
              await ctx.answerCallback("This add flow expired. Start again.");
              return "handled" as const;
            }
            if (action.kind === "category") {
              const draft = { ...action.draft, categoryId: action.value };
              deps.setDraft(draft);
              await ctx.edit(sentimentView(ctx, registerAction, draft));
            } else {
              const result = execute({ action: "start", name: action.draft.name, category_id: action.draft.categoryId!, sentiment: action.value as "liked" | "alright" | "disliked" });
              deps.setDraft(undefined);
              await ctx.edit(directResultView(current, result, ctx, registerAction));
            }
            await ctx.answerCallback();
            return "handled" as const;
          }
          let result: unknown;
          try {
            result = action.kind === "command" ? execute(action.command) : action.kind === "answer"
              ? execute({
                  action: "answer",
                  insertion_id: action.insertionId,
                  revision: action.revision,
                  existing_place_id: action.existingPlaceId,
                  winner: action.winner,
                })
              : execute({ action: "back", insertion_id: action.insertionId, revision: action.revision });
          } catch (error) {
            if (!(error instanceof PlacesServiceError) || error.code !== "STALE_ACTION") throw error;
            try {
              result = current.execute({ action: "resume" });
            } catch {
              await ctx.edit(placesMenuView(ctx));
              await ctx.answerCallback("That comparison is no longer active.");
              return "handled" as const;
            }
          }
          await ctx.edit(directResultView(current, result, ctx, registerAction));
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "cancel": {
          const active = current.execute({ action: "resume" });
          if (active.kind !== "compare" || active.insertionId !== ctx.payload) {
            await ctx.answerCallback("That comparison is no longer active.");
            return "handled" as const;
          }
          await ctx.edit({
            text: "<b>Cancel this unfinished ranking?</b>",
            replyMarkup: {
              inline_keyboard: [[{
                text: "🗑 Confirm cancel",
                callback_data: ctx.callbackData("direct", registerAction({ kind: "command", command: (() => {
                  const confirmation = execute({ action: "request_confirmation", confirmation_operation: "cancel", insertion_id: active.insertionId, revision: active.revision });
                  if (confirmation.kind !== "confirmation") throw new Error("Missing confirmation");
                  return { action: "cancel", insertion_id: active.insertionId, revision: active.revision, confirmation_token: confirmation.token };
                })() })),
              }]],
            },
          });
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "notes":
        case "rename-place":
          current.execute({ action: "place", place_id: ctx.payload }).place;
          await ask(ctx, ctx.action === "notes" ? "notes (send /clear to remove them)" : "the new place name", (text) => {
            execute({ action: "edit_place", place_id: ctx.payload, ...(ctx.action === "notes" ? { notes: text === "/clear" ? "" : text } : { name: text }) });
            return placeView(current, ctx.payload, ctx);
          });
          return "handled" as const;
        case "manage": {
          const place = current.execute({ action: "place", place_id: ctx.payload }).place;
          await ctx.edit({ text: `<b>Manage ${escapeHtml(place.name)}</b>`, replyMarkup: { inline_keyboard: [
            [{ text: "Edit name", callback_data: ctx.callbackData("rename-place", place.id) }],
            [{ text: "Edit notes", callback_data: ctx.callbackData("notes", place.id) }],
            [{ text: "Move category", callback_data: ctx.callbackData("move", place.id) }],
            [{ text: "Re-rank", callback_data: ctx.callbackData("rerank", place.id) }],
            [commandButton(ctx, "Delete", { action: "request_confirmation", confirmation_operation: "delete_place", place_id: place.id })],
          ] } });
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "move":
        case "rerank": {
          const place = current.execute({ action: "place", place_id: ctx.payload }).place;
          const buttons = ctx.action === "move"
            ? current.execute({ action: "categories" }).categories.map((category) => commandButton(ctx, category.name, { action: "reposition", place_id: place.id, category_id: category.id }))
            : (["liked", "alright", "disliked"] as const).map((sentiment) => commandButton(ctx, sentiment, { action: "reposition", place_id: place.id, sentiment }));
          await ctx.edit({ text: ctx.action === "move" ? "Choose a category." : "Choose your overall impression.", replyMarkup: { inline_keyboard: buttons.map((button) => [button]) } });
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "manage-categories":
          await ctx.edit({ text: "Choose a category to manage.", replyMarkup: { inline_keyboard: current.execute({ action: "categories" }).categories.map((category) => [{ text: category.name, callback_data: ctx.callbackData("manage-category", category.id) }]) } });
          await ctx.answerCallback();
          return "handled" as const;
        case "manage-category":
          await ctx.edit({ text: "Rename this category or delete it if empty.", replyMarkup: { inline_keyboard: [
            [{ text: "Rename", callback_data: ctx.callbackData("rename-category", ctx.payload) }],
            [commandButton(ctx, "Delete empty category", { action: "request_confirmation", confirmation_operation: "delete_category", category_id: ctx.payload })],
          ] } });
          await ctx.answerCallback();
          return "handled" as const;
        case "rename-category":
          await ask(ctx, "the new category name", (name) => { execute({ action: "rename_category", category_id: ctx.payload, name }); return categorySummariesView(current, ctx); });
          return "handled" as const;
        default:
          return "pass" as const;
      }
      } catch (error) {
        await ctx.answerCallback(error instanceof PlacesServiceError ? error.message : "That interaction expired. Open /place_rankings again.");
        return "handled" as const;
      }
    },
  };
}

function placesMenuView(ctx: TelegramSectionContext): TelegramSectionView {
  return {
    text: "<b>📍 Place Rankings</b>\n\nAdd a place or browse your rankings.",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "➕ Add place", callback_data: ctx.callbackData("add") }],
        [{ text: "🏆 View rankings", callback_data: ctx.callbackData("summaries") }],
        [{ text: "🛠 Manage places", callback_data: ctx.callbackData("summaries") }],
        [{ text: "➕ New category", callback_data: ctx.callbackData("new-category") }],
        [{ text: "Manage categories", callback_data: ctx.callbackData("manage-categories") }],
      ],
    },
  };
}

function categoryPickerView(service: PlacesApplication, ctx: TelegramSectionContext, registerAction: (action: DirectAction) => string, draft: AddDraft | undefined): TelegramSectionView {
  if (!draft) return placesMenuView(ctx);
  return {
    text: "<b>Choose a category</b>",
    replyMarkup: {
      inline_keyboard: [
        ...service.execute({ action: "categories" }).categories.map((category) => [{
          text: category.name,
          callback_data: ctx.callbackData("direct", registerAction({ kind: "category", draft, value: category.id })),
        }]),
        [{ text: "➕ New category", callback_data: ctx.callbackData("new-category") }],
      ],
    },
  };
}

function sentimentView(ctx: TelegramSectionContext, registerAction: (action: DirectAction) => string, draft: AddDraft): TelegramSectionView {
  return {
    text: "<b>What was your overall impression?</b>",
    replyMarkup: {
      inline_keyboard: [[
        { text: "👍 Liked", callback_data: ctx.callbackData("direct", registerAction({ kind: "sentiment", draft, value: "liked" })) },
        { text: "👌 Alright", callback_data: ctx.callbackData("direct", registerAction({ kind: "sentiment", draft, value: "alright" })) },
        { text: "👎 Disliked", callback_data: ctx.callbackData("direct", registerAction({ kind: "sentiment", draft, value: "disliked" })) },
      ]],
    },
  };
}

function categorySummariesView(service: PlacesApplication, ctx: TelegramSectionContext): TelegramSectionView {
  const categories = service.execute({ action: "category_summaries" }).categories;
  return {
    text: "<b>Rankings</b>\n\nChoose a category.",
    replyMarkup: {
      inline_keyboard: categories.map((category) => [{
        text: `${category.name} (${category.placeCount})`,
        callback_data: ctx.callbackData("rank", category.id),
      }]),
    },
  };
}

function rankingView(
  service: PlacesApplication,
  categoryId: string,
  offset: number,
  limit: number,
  ctx: TelegramSectionContext,
): TelegramSectionView {
  const category = service.execute({ action: "category_summaries" }).categories.find((entry) => entry.id === categoryId);
  if (!category) throw new Error("That category no longer exists.");
  const ranking = service.execute({ action: "ranking", category_id: categoryId, offset, limit });
  const page = ranking.places;
  const lines = page.length === 0
    ? ["No places ranked yet."]
    : page.map((place, index) => `${offset + index + 1}. ${escapeHtml(place.name)}`);
  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (offset > 0) {
    navigation.push({
      text: "⬅️ Previous",
      callback_data: ctx.callbackData("page", `${categoryId},${Math.max(0, offset - limit)}`),
    });
  }
  if (ranking.hasNext) {
    navigation.push({
      text: "Next ➡️",
      callback_data: ctx.callbackData("page", `${categoryId},${offset + limit}`),
    });
  }
  return {
    text: `<b>${escapeHtml(category.name)}</b>\n\n${lines.join("\n")}`,
    replyMarkup: {
      inline_keyboard: [
        ...page.map((place) => [{
          text: place.name,
          callback_data: ctx.callbackData("place", place.id),
        }]),
        ...(navigation.length > 0 ? [navigation] : []),
      ],
    },
  };
}

function placeView(service: PlacesApplication, placeId: string, ctx: TelegramSectionContext): TelegramSectionView {
  const place = service.execute({ action: "place", place_id: placeId }).place;
  return {
    text: [
      `<b>${escapeHtml(place.name)}</b>`,
      `Rank: #${place.position + 1}`,
      `Sentiment: ${place.sentiment}`,
      ...(place.notes ? [`Notes: ${escapeHtml(place.notes)}`] : []),
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "📝 Add/edit notes", callback_data: ctx.callbackData("notes", place.id) }],
        [{ text: "🛠 Manage", callback_data: ctx.callbackData("manage", place.id) }],
      ],
    },
  };
}

function directResultView(
  service: PlacesApplication,
  result: unknown,
  ctx: TelegramSectionContext,
  registerAction: (action: DirectAction) => string,
): TelegramSectionView {
  if (!result || typeof result !== "object") return placesMenuView(ctx);
  const value = result as Record<string, unknown>;
  if (value.kind === "confirmation") {
    const params = value.params as PlacesCommand;
    const command: PlacesCommand = { ...params, action: params.confirmation_operation!, confirmation_token: String(value.token) };
    return { text: "Confirm this change?", replyMarkup: { inline_keyboard: [[{ text: "Confirm", callback_data: ctx.callbackData("direct", registerAction({ kind: "command", command })) }], [{ text: "Keep unchanged", callback_data: ctx.callbackData("menu") }]] } };
  }
  if (value.kind === "stale") {
    return value.current
      ? directResultView(service, value.current, ctx, registerAction)
      : { ...placesMenuView(ctx), text: "That interaction expired. Start again." };
  }
  if (value.kind === "complete") {
    const place = value.place as { id?: unknown; name?: unknown } | undefined;
    const category = value.category as { id?: unknown; name?: unknown } | undefined;
    if (
      typeof place?.id !== "string" ||
      typeof place.name !== "string" ||
      typeof category?.id !== "string" ||
      typeof value.rank !== "number" ||
      !Number.isSafeInteger(value.rank) ||
      typeof value.total !== "number" ||
      !Number.isSafeInteger(value.total)
    ) {
      return placesMenuView(ctx);
    }
    return {
      text: `<b>Ranked ${escapeHtml(place.name)}</b>\n\n#${value.rank} of ${value.total} in ${escapeHtml(String(category.name ?? "category"))}.`,
      replyMarkup: {
        inline_keyboard: [
          [{ text: "📝 Add notes", callback_data: ctx.callbackData("notes", place.id) }],
          [{ text: "🏆 View ranking", callback_data: ctx.callbackData("rank", category.id) }],
          [{ text: "➕ Add another", callback_data: ctx.callbackData("add") }],
          ...(typeof value.undoInsertionId === "string" ? [[{ text: "Undo addition", callback_data: ctx.callbackData("direct", registerAction({ kind: "command", command: { action: "request_confirmation", confirmation_operation: "undo_addition", insertion_id: value.undoInsertionId } })) }]] : []),
        ],
      },
    };
  }
  if (value.kind !== "compare") return placesMenuView(ctx);
  const candidate = value.candidate as { name?: unknown } | undefined;
  const existing = value.existingPlace as { id?: unknown; name?: unknown } | undefined;
  if (
    typeof value.insertionId !== "string" ||
    typeof value.revision !== "number" ||
    typeof candidate?.name !== "string" ||
    typeof existing?.id !== "string" ||
    typeof existing.name !== "string"
  ) {
    return placesMenuView(ctx);
  }
  const action = (winner: "candidate" | "existing") => registerAction({
    kind: "answer",
    insertionId: value.insertionId as string,
    revision: value.revision as number,
    existingPlaceId: existing.id as string,
    winner,
  });
  const rows = [[
    { text: candidate.name, callback_data: ctx.callbackData("direct", action("candidate")) },
    { text: existing.name, callback_data: ctx.callbackData("direct", action("existing")) },
  ]];
  if (value.revision > 0) {
    rows.push([{
      text: "⬅️ Back",
      callback_data: ctx.callbackData("direct", registerAction({
        kind: "back",
        insertionId: value.insertionId,
        revision: value.revision,
      })),
    }]);
  }
  rows.push([{
    text: "🗑 Cancel",
    callback_data: ctx.callbackData("cancel", value.insertionId),
  }]);
  return {
    text: `<b>Which is better?</b>\n\n${escapeHtml(candidate.name)} or ${escapeHtml(existing.name)}?`,
    replyMarkup: { inline_keyboard: rows },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
