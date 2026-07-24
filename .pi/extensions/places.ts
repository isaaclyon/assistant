import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";

import {
  PlacesService,
  PlacesServiceError,
} from "../../src/places-service.ts";
import { openPlacesStore, type PlacesStore } from "../../src/places-store.ts";
import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";

const ActionSchema = StringEnum([
  "menu",
  "categories",
  "category_summaries",
  "create_category",
  "rename_category",
  "delete_category",
  "start",
  "place",
  "edit_place",
  "delete_place",
  "reposition",
  "undo_addition",
  "resume",
  "answer",
  "back",
  "cancel",
  "ranking",
] as const);
const SentimentSchema = StringEnum(["liked", "alright", "disliked"] as const);
const WinnerSchema = StringEnum(["candidate", "existing"] as const);

export default function placesExtension(pi: ExtensionAPI): void {
  let store: PlacesStore | undefined;
  let service: PlacesService | undefined;

  pi.on("session_start", () => {
    store?.close();
    const stateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;
    if (!stateDir) return;
    store = openPlacesStore(join(stateDir, "places.db"));
    service = new PlacesService(store, { ownerKey: "private-telegram-surface" });
  });
  pi.on("session_shutdown", () => {
    store?.close();
    store = undefined;
    service = undefined;
  });

  registerReloadSafeTelegramCommand({
    name: "places",
    description: "Add, compare, and view your private place rankings.",
    showInMenu: true,
    emoji: "📍",
    handler: async (ctx) => {
      await ctx.enqueuePrompt(PLACES_MENU_PROMPT);
    },
  });

  pi.registerTool({
    name: "places",
    label: "Places",
    description:
      "Maintain the user's private restaurant, coffee-shop, bar, and other place rankings. Supports categories, adding a place, durable pairwise comparisons, resume/cancel, and paginated rankings.",
    promptSnippet: "Add, compare, resume, cancel, or list private place rankings",
    promptGuidelines: [
      "Use places whenever the user asks to add, rank, compare, resume, cancel, or list restaurants, coffee shops, bars, or other saved places.",
      "After a places result with kind=compare, ask exactly that comparison and preserve insertionId, revision, and existingPlace.id in the button prompts; never invent ranking state.",
      "Render places choices as telegram_button prompt actions when responding on Telegram, while keeping the visible response concise.",
      "Require explicit user confirmation before calling places delete_place, delete_category, undo_addition, or cancel.",
    ],
    parameters: Type.Object({
      action: ActionSchema,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      category_id: Type.Optional(Type.String()),
      place_id: Type.Optional(Type.String()),
      sentiment: Type.Optional(SentimentSchema),
      notes: Type.Optional(Type.String({ maxLength: 4_000 })),
      insertion_id: Type.Optional(Type.String()),
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
      existing_place_id: Type.Optional(Type.String()),
      winner: Type.Optional(WinnerSchema),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params) {
      if (!service) {
        return toolResult({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Places is unavailable outside the configured bridge runtime.",
          },
        });
      }
      try {
        let result: unknown;
        switch (params.action) {
          case "menu": {
            let active: unknown;
            try {
              active = service.resume();
            } catch (error) {
              if (!(error instanceof PlacesServiceError) || error.code !== "NO_ACTIVE_INSERTION") {
                throw error;
              }
            }
            result = { categories: service.listCategories(), ...(active ? { active } : {}) };
            break;
          }
          case "categories":
            result = { categories: service.listCategories() };
            break;
          case "category_summaries":
            result = { categories: service.listCategorySummaries() };
            break;
          case "create_category":
            if (!params.name) throw invalid("create_category requires name");
            result = { category: service.createCategory(params.name) };
            break;
          case "rename_category":
            if (!params.category_id || !params.name) {
              throw invalid("rename_category requires category_id and name");
            }
            result = { category: service.renameCategory(params.category_id, params.name) };
            break;
          case "delete_category":
            if (!params.category_id) throw invalid("delete_category requires category_id");
            service.deleteCategory(params.category_id);
            result = { deleted: true };
            break;
          case "start":
            if (!params.name || !params.category_id || !params.sentiment) {
              throw invalid("start requires name, category_id, and sentiment");
            }
            result = service.start({
              name: params.name,
              categoryId: params.category_id,
              sentiment: params.sentiment,
              ...(params.notes !== undefined ? { notes: params.notes } : {}),
            });
            break;
          case "place":
            if (!params.place_id) throw invalid("place requires place_id");
            result = { place: service.getPlace(params.place_id) };
            break;
          case "edit_place":
            if (!params.place_id || (params.name === undefined && params.notes === undefined)) {
              throw invalid("edit_place requires place_id and name or notes");
            }
            result = {
              place: service.editPlace(params.place_id, {
                ...(params.name !== undefined ? { name: params.name } : {}),
                ...(params.notes !== undefined ? { notes: params.notes } : {}),
              }),
            };
            break;
          case "delete_place":
            if (!params.place_id) throw invalid("delete_place requires place_id");
            service.deletePlace(params.place_id);
            result = { deleted: true };
            break;
          case "reposition":
            if (!params.place_id) throw invalid("reposition requires place_id");
            result = service.reposition(params.place_id, {
              ...(params.category_id !== undefined ? { categoryId: params.category_id } : {}),
              ...(params.sentiment !== undefined ? { sentiment: params.sentiment } : {}),
            });
            break;
          case "undo_addition":
            if (!params.insertion_id) throw invalid("undo_addition requires insertion_id");
            service.undoAddition(params.insertion_id);
            result = { undone: true };
            break;
          case "resume":
            result = service.resume();
            break;
          case "answer":
            if (
              !params.insertion_id ||
              params.revision === undefined ||
              !params.existing_place_id ||
              !params.winner
            ) {
              throw invalid(
                "answer requires insertion_id, revision, existing_place_id, and winner",
              );
            }
            result = service.answer({
              insertionId: params.insertion_id,
              revision: params.revision,
              existingPlaceId: params.existing_place_id,
              winner: params.winner,
            });
            break;
          case "back":
            if (!params.insertion_id || params.revision === undefined) {
              throw invalid("back requires insertion_id and revision");
            }
            result = service.back(params.insertion_id, params.revision);
            break;
          case "cancel":
            if (!params.insertion_id || params.revision === undefined) {
              throw invalid("cancel requires insertion_id and revision");
            }
            service.cancel(params.insertion_id, params.revision);
            result = { cancelled: true };
            break;
          case "ranking": {
            if (!params.category_id) throw invalid("ranking requires category_id");
            const ranking = service.listRanking(params.category_id);
            const offset = params.offset ?? 0;
            const limit = params.limit ?? 25;
            result = {
              categoryId: params.category_id,
              offset,
              limit,
              total: ranking.length,
              places: ranking.slice(offset, offset + limit),
            };
            break;
          }
        }
        return toolResult({ ok: true, result: addButtonActions(result) });
      } catch (error) {
        const safe =
          error instanceof PlacesServiceError
            ? error
            : invalid(error instanceof Error ? error.message : "Invalid places action");
        return toolResult({
          ok: false,
          error: { code: safe.code, message: safe.message },
        });
      }
    },
  });
}

const PLACES_MENU_PROMPT = `# Places menu

Open my private places-ranking menu now.

1. Call the places tool with action "menu" before responding.
2. If an active comparison exists, lead with it and use the exact action prompts returned by the tool.
3. Otherwise show concise Telegram buttons for Add place and View rankings. Add place should ask for the name, then use action "categories" and ask for sentiment before action "start". View rankings should ask which returned category to open.
4. Use top-level telegram_button comments with explicit label and prompt attributes. Do not expose internal IDs in visible prose, but preserve every ID and revision exactly inside the button prompt.
5. Do not claim an add, answer, cancellation, or final rank until the places tool reports success.`;

function addButtonActions(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  if (value.kind === "complete") {
    const category = value.category;
    const undoInsertionId = value.undoInsertionId;
    const categoryId =
      category && typeof category === "object"
        ? (category as { id?: unknown }).id
        : undefined;
    const buttonActions: Array<{ label: string; prompt: string }> = [];
    if (typeof categoryId === "string") {
      buttonActions.push({
        label: "View ranking",
        prompt: `Show this place ranking by calling places with action "ranking" and category_id ${JSON.stringify(categoryId)}.`,
      });
    }
    if (typeof undoInsertionId === "string") {
      buttonActions.push({
        label: "Undo addition",
        prompt: `Ask me to confirm undoing the newly added place from insertion ${JSON.stringify(undoInsertionId)}. Only after confirmation call places with action "undo_addition" and that insertion_id.`,
      });
    }
    return { ...value, ...(buttonActions.length > 0 ? { buttonActions } : {}) };
  }
  if (value.kind !== "compare") return result;
  const insertionId = value.insertionId;
  const revision = value.revision;
  const candidate = value.candidate;
  const existing = value.existingPlace;
  if (
    typeof insertionId !== "string" ||
    typeof revision !== "number" ||
    !candidate ||
    typeof candidate !== "object" ||
    !existing ||
    typeof existing !== "object"
  ) {
    return result;
  }
  const candidateName = (candidate as { name?: unknown }).name;
  const existingId = (existing as { id?: unknown }).id;
  const existingName = (existing as { name?: unknown }).name;
  if (
    typeof candidateName !== "string" ||
    typeof existingId !== "string" ||
    typeof existingName !== "string"
  ) {
    return result;
  }
  const answerPrompt = (winner: "candidate" | "existing") =>
    `Continue my place ranking by calling places with action "answer", insertion_id ${JSON.stringify(insertionId)}, revision ${revision}, existing_place_id ${JSON.stringify(existingId)}, and winner "${winner}". Use the returned exact next step.`;
  return {
    ...value,
    buttonActions: [
      { label: candidateName, prompt: answerPrompt("candidate") },
      { label: existingName, prompt: answerPrompt("existing") },
      {
        label: "Back",
        prompt: `Go back one place comparison by calling places with action "back", insertion_id ${JSON.stringify(insertionId)}, and revision ${revision}. Use the returned exact step.`,
      },
      {
        label: "Cancel",
        prompt: `Ask me to confirm cancelling place insertion ${JSON.stringify(insertionId)} at revision ${revision}. Do not call places cancel until I confirm.`,
      },
    ],
  };
}

function invalid(message: string): PlacesServiceError {
  return new PlacesServiceError("INVALID_ACTION", message);
}

function toolResult(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}
