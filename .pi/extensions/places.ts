import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";

import {
  PlacesService,
  PlacesServiceError,
} from "../../src/places-service.ts";
import { normalizePlaceName, openPlacesStore, type PlacesStore } from "../../src/places-store.ts";
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
  "request_confirmation",
  "resume",
  "answer",
  "back",
  "cancel",
  "ranking",
] as const);
const SentimentSchema = StringEnum(["liked", "alright", "disliked"] as const);
const WinnerSchema = StringEnum(["candidate", "existing"] as const);
const ConfirmationOperationSchema = StringEnum([
  "cancel",
  "delete_place",
  "delete_category",
  "undo_addition",
] as const);
type ConfirmationOperation = "cancel" | "delete_place" | "delete_category" | "undo_addition";

export default function placesExtension(pi: ExtensionAPI): void {
  let store: PlacesStore | undefined;
  let service: PlacesService | undefined;
  const confirmations = new Map<string, { operation: ConfirmationOperation; target: string; expiresAt: number }>();

  pi.on("session_start", () => {
    store?.close();
    store = undefined;
    service = undefined;
    confirmations.clear();
    const stateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;
    const principal = process.env.PI_TELEGRAM_PRINCIPAL;
    const instanceId = process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID ?? "compatibility-singleton";
    if (!stateDir || principal !== "isaac") return;
    store = openPlacesStore(join(stateDir, "places.db"));
    service = new PlacesService(store, { ownerKey: `instance:${instanceId}:principal:${principal}` });
  });
  pi.on("session_shutdown", () => {
    store?.close();
    store = undefined;
    service = undefined;
    confirmations.clear();
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
      "Before a destructive places action, call places request_confirmation and render its exact Confirm button; only that operation-bound token can authorize delete_place, delete_category, undo_addition, or cancel.",
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
      confirmation_operation: Type.Optional(ConfirmationOperationSchema),
      confirmation_token: Type.Optional(Type.String()),
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
            consumeConfirmation(confirmations, params.confirmation_token, "delete_category", params.category_id);
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
            consumeConfirmation(confirmations, params.confirmation_token, "delete_place", params.place_id);
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
            consumeConfirmation(confirmations, params.confirmation_token, "undo_addition", params.insertion_id);
            service.undoAddition(params.insertion_id);
            result = { undone: true };
            break;
          case "request_confirmation": {
            if (!params.confirmation_operation) throw invalid("request_confirmation requires confirmation_operation");
            const target = confirmationTarget(params.confirmation_operation, params);
            const now = Date.now();
            for (const [existingToken, confirmation] of confirmations) {
              if (confirmation.expiresAt < now) confirmations.delete(existingToken);
            }
            if (confirmations.size >= 32) {
              const oldest = confirmations.keys().next().value as string | undefined;
              if (oldest) confirmations.delete(oldest);
            }
            const token = randomUUID();
            confirmations.set(token, {
              operation: params.confirmation_operation,
              target,
              expiresAt: now + 10 * 60_000,
            });
            result = {
              kind: "confirmation",
              operation: params.confirmation_operation,
              buttonActions: [{
                label: "Confirm",
                prompt: destructivePrompt(params.confirmation_operation, params, token),
              }],
            };
            break;
          }
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
            consumeConfirmation(confirmations, params.confirmation_token, "cancel", `${params.insertion_id}:${params.revision}`);
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
              hasPrevious: offset > 0,
              hasNext: offset + limit < ranking.length,
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
        if (
          (safe.code === "STALE_ACTION" || safe.code === "NO_ACTIVE_INSERTION") &&
          ["answer", "back", "cancel"].includes(params.action)
        ) {
          let current: unknown = null;
          try {
            current = addButtonActions(service.resume());
          } catch {
            // No resumable state means the old action is a safe no-op.
          }
          return toolResult({
            ok: true,
            result: {
              kind: "stale",
              message: safe.message,
              current,
              restartRequired: current === null,
            },
          });
        }
        if (safe.code === "DUPLICATE_PLACE" && params.action === "start" && params.category_id && params.name) {
          const existing = service.listRanking(params.category_id).find(
            (place) => place.normalizedName === normalizePlaceName(params.name ?? ""),
          );
          return toolResult({
            ok: false,
            error: { code: safe.code, message: safe.message },
            ...(existing ? {
              existing: { id: existing.id, name: existing.name },
              buttonActions: [
                { label: "View existing", prompt: `Show details by calling places with action "place" and place_id ${JSON.stringify(existing.id)}.` },
                { label: "Enter another name", prompt: "Ask me for a more specific place name, then retry the add flow." },
                { label: "Cancel", prompt: "Cancel this duplicate add attempt without changing places." },
              ],
            } : {}),
          });
        }
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
3. Render the exact buttonActions returned by the tool. The menu includes Add place, View rankings, Manage places, New category, and active Resume/Cancel actions when applicable.
4. Use top-level telegram_button comments with explicit label and prompt attributes. Do not expose internal IDs in visible prose, but preserve every ID and revision exactly inside the button prompt.
5. Do not claim an add, answer, cancellation, or final rank until the places tool reports success.`;

function addButtonActions(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  if (Array.isArray(value.categories)) {
    const active = value.active ? addButtonActions(value.active) : undefined;
    const categoryButtons = value.categories.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const category = entry as { id?: unknown; name?: unknown };
      if (typeof category.id !== "string" || typeof category.name !== "string") return [];
      return [{
        label: category.name,
        prompt: `Open ${JSON.stringify(category.name)} by calling places with action "ranking" and category_id ${JSON.stringify(category.id)}.`,
      }];
    });
    if ("active" in value) {
      return {
        ...value,
        ...(active ? { active } : {}),
        buttonActions: [
          { label: "Resume ranking", prompt: 'Resume my unfinished ranking by calling places with action "resume" and use the returned exact buttons.' },
          { label: "Cancel ranking", prompt: 'Call places with action "resume", then request an operation-bound cancel confirmation for its insertion ID and revision.' },
          { label: "View rankings", prompt: 'Call places with action "category_summaries" and render every returned category button.' },
        ],
      };
    }
    const summaries = value.categories.some((entry) => entry && typeof entry === "object" && "placeCount" in entry);
    if (summaries) {
      categoryButtons.push(
        { label: "New category", prompt: 'Ask me for the category name, then call places with action "create_category".' },
        { label: "Manage categories", prompt: 'Ask which category to rename or delete. Use rename_category directly; for deletion request an operation-bound delete_category confirmation and note that only empty categories can be deleted.' },
      );
    }
    return {
      ...value,
      buttonActions: summaries
        ? categoryButtons
        : [
            { label: "Add place", prompt: 'Ask me for the place name, then call places with action "categories" and continue through category, sentiment, and optional notes before action "start".' },
            { label: "View rankings", prompt: 'Call places with action "category_summaries" and render every returned category button.' },
            { label: "Manage places", prompt: 'Call places with action "category_summaries", ask which category to manage, then show its ranking with place-detail buttons.' },
            { label: "New category", prompt: 'Ask me for the new category name, then call places with action "create_category".' },
          ],
    };
  }
  if (Array.isArray(value.places) && typeof value.categoryId === "string") {
    const offset = typeof value.offset === "number" ? value.offset : 0;
    const limit = typeof value.limit === "number" ? value.limit : 25;
    const actions = value.places.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const place = entry as { id?: unknown; name?: unknown };
      if (typeof place.id !== "string" || typeof place.name !== "string") return [];
      return [{ label: place.name, prompt: `Show details by calling places with action "place" and place_id ${JSON.stringify(place.id)}.` }];
    });
    if (value.hasPrevious === true) actions.push({ label: "Previous", prompt: `Call places with action "ranking", category_id ${JSON.stringify(value.categoryId)}, offset ${Math.max(0, offset - limit)}, and limit ${limit}.` });
    if (value.hasNext === true) actions.push({ label: "Next", prompt: `Call places with action "ranking", category_id ${JSON.stringify(value.categoryId)}, offset ${offset + limit}, and limit ${limit}.` });
    return { ...value, buttonActions: actions };
  }
  if (value.kind !== "complete" && value.place && typeof value.place === "object") {
    const place = value.place as { id?: unknown; name?: unknown; categoryId?: unknown; sentiment?: unknown };
    if (typeof place.id === "string") {
      return {
        ...value,
        buttonActions: [
          { label: "Edit name or notes", prompt: `Ask what to change, then call places with action "edit_place" and place_id ${JSON.stringify(place.id)}.` },
          { label: "Move", prompt: `Call places with action "categories", ask for the target category, then call places with action "reposition" and place_id ${JSON.stringify(place.id)}.` },
          { label: "Re-rank", prompt: `Ask for the sentiment, then call places with action "reposition" and place_id ${JSON.stringify(place.id)} using the current category.` },
          { label: "Delete", prompt: `Request an operation-bound delete_place confirmation for place_id ${JSON.stringify(place.id)}.` },
        ],
      };
    }
  }
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
    const place = value.place;
    const placeId = place && typeof place === "object" ? (place as { id?: unknown }).id : undefined;
    if (typeof placeId === "string") {
      buttonActions.unshift({
        label: "Add notes",
        prompt: `Ask me for notes, then call places with action "edit_place" and place_id ${JSON.stringify(placeId)} using those notes.`,
      });
    }
    if (typeof undoInsertionId === "string") {
      buttonActions.push({
        label: "Undo addition",
        prompt: `Request an operation-bound undo_addition confirmation for insertion_id ${JSON.stringify(undoInsertionId)}.`,
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
  const buttonActions = [
    { label: candidateName, prompt: answerPrompt("candidate") },
    { label: existingName, prompt: answerPrompt("existing") },
  ];
  if (revision > 0) {
    buttonActions.push({
      label: "Back",
      prompt: `Go back one place comparison by calling places with action "back", insertion_id ${JSON.stringify(insertionId)}, and revision ${revision}. Use the returned exact step.`,
    });
  }
  buttonActions.push({
    label: "Cancel",
    prompt: `Request an operation-bound cancel confirmation for insertion_id ${JSON.stringify(insertionId)} at revision ${revision}.`,
  });
  return {
    ...value,
    buttonActions,
  };
}

type ConfirmationParams = {
  insertion_id?: string;
  revision?: number;
  place_id?: string;
  category_id?: string;
};

function confirmationTarget(operation: ConfirmationOperation, params: ConfirmationParams): string {
  if (operation === "cancel") {
    if (!params.insertion_id || params.revision === undefined) throw invalid("cancel confirmation requires insertion_id and revision");
    return `${params.insertion_id}:${params.revision}`;
  }
  if (operation === "delete_place") {
    if (!params.place_id) throw invalid("delete_place confirmation requires place_id");
    return params.place_id;
  }
  if (operation === "delete_category") {
    if (!params.category_id) throw invalid("delete_category confirmation requires category_id");
    return params.category_id;
  }
  if (!params.insertion_id) throw invalid("undo_addition confirmation requires insertion_id");
  return params.insertion_id;
}

function destructivePrompt(operation: ConfirmationOperation, params: ConfirmationParams, token: string): string {
  const fields = operation === "cancel"
    ? `insertion_id ${JSON.stringify(params.insertion_id)} and revision ${params.revision}`
    : operation === "delete_place"
      ? `place_id ${JSON.stringify(params.place_id)}`
      : operation === "delete_category"
        ? `category_id ${JSON.stringify(params.category_id)}`
        : `insertion_id ${JSON.stringify(params.insertion_id)}`;
  return `Confirm now by calling places with action ${JSON.stringify(operation)}, ${fields}, and confirmation_token ${JSON.stringify(token)}. Use it once and report the exact result.`;
}

function consumeConfirmation(
  confirmations: Map<string, { operation: ConfirmationOperation; target: string; expiresAt: number }>,
  token: string | undefined,
  operation: ConfirmationOperation,
  target: string,
): void {
  if (!token) throw invalid(`${operation} requires an operation-bound confirmation token`);
  const confirmation = confirmations.get(token);
  confirmations.delete(token);
  if (!confirmation || confirmation.expiresAt < Date.now() || confirmation.operation !== operation || confirmation.target !== target) {
    throw invalid("That confirmation is missing, expired, already used, or belongs to another operation");
  }
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
