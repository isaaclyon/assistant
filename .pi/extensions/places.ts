import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  presentTelegramSection,
  registerTelegramSection,
  type TelegramSectionCallbackContext,
  type TelegramSectionContext,
  type TelegramSectionView,
} from "@llblab/pi-telegram/sections";
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
const PLACES_SECTION_ID = "assistant/places";

type DirectAction =
  | { kind: "answer"; insertionId: string; revision: number; existingPlaceId: string; winner: "candidate" | "existing" }
  | { kind: "back"; insertionId: string; revision: number };

type DirectPendingView =
  | { kind: "categories" }
  | { kind: "result"; value: unknown };

export default function placesExtension(pi: ExtensionAPI): void {
  let store: PlacesStore | undefined;
  let service: PlacesService | undefined;
  let unregisterSection: (() => void) | undefined;
  let pendingDirectView: DirectPendingView | undefined;
  let draftAdd: { name: string; categoryId?: string } | undefined;
  let nextDirectAction = 0;
  const directActions = new Map<string, DirectAction>();
  const confirmations = new Map<string, { operation: ConfirmationOperation; target: string; expiresAt: number }>();

  pi.on("session_start", () => {
    store?.close();
    store = undefined;
    service = undefined;
    confirmations.clear();
    directActions.clear();
    pendingDirectView = undefined;
    draftAdd = undefined;
    const stateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;
    const principal = process.env.PI_TELEGRAM_PRINCIPAL;
    const instanceId = process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID ?? "compatibility-singleton";
    if (!stateDir || principal !== "isaac") return;
    store = openPlacesStore(join(stateDir, "places.db"));
    service = new PlacesService(store, { ownerKey: `instance:${instanceId}:principal:${principal}` });
    unregisterSection?.();
    unregisterSection = registerTelegramSection(createPlacesSection({
      getService: () => service,
      takePendingView: () => {
        const pending = pendingDirectView;
        pendingDirectView = undefined;
        return pending;
      },
      getDraft: () => draftAdd,
      setDraft: (draft) => {
        draftAdd = draft;
      },
      registerAction: (action) => {
        const token = (nextDirectAction++).toString(36);
        directActions.set(token, action);
        if (directActions.size > 128) {
          const oldest = directActions.keys().next().value as string | undefined;
          if (oldest) directActions.delete(oldest);
        }
        return token;
      },
      getAction: (token) => directActions.get(token),
    }));
  });
  pi.on("session_shutdown", () => {
    unregisterSection?.();
    unregisterSection = undefined;
    store?.close();
    store = undefined;
    service = undefined;
    confirmations.clear();
    directActions.clear();
    pendingDirectView = undefined;
    draftAdd = undefined;
  });

  registerReloadSafeTelegramCommand({
    name: "places",
    description: "Add, compare, and view your private place rankings.",
    showInMenu: true,
    emoji: "📍",
    handler: async (ctx) => {
      await ctx.openSection(PLACES_SECTION_ID);
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
      "When adding a place from Telegram, collect its name, then call places with action categories and that name; the direct Telegram section owns category, sentiment, and comparison buttons.",
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
        let presented = false;
        if (params.action === "categories" && params.name) {
          draftAdd = { name: params.name };
          pendingDirectView = { kind: "categories" };
          presented = await tryPresentPlacesSection();
        } else if (params.action === "start") {
          pendingDirectView = { kind: "result", value: result };
          presented = await tryPresentPlacesSection();
        }
        return toolResult({ ok: true, result: addButtonActions(result) }, presented);
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

async function tryPresentPlacesSection(): Promise<boolean> {
  try {
    await presentTelegramSection(PLACES_SECTION_ID);
    return true;
  } catch {
    return false;
  }
}

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

function createPlacesSection(deps: {
  getService: () => PlacesService | undefined;
  takePendingView: () => DirectPendingView | undefined;
  getDraft: () => { name: string; categoryId?: string } | undefined;
  setDraft: (draft: { name: string; categoryId?: string } | undefined) => void;
  registerAction: (action: DirectAction) => string;
  getAction: (token: string) => DirectAction | undefined;
}) {
  const requireService = (): PlacesService => {
    const current = deps.getService();
    if (!current) throw new Error("Places is unavailable.");
    return current;
  };
  const render = (ctx: TelegramSectionContext): TelegramSectionView => {
    const current = requireService();
    const pending = deps.takePendingView();
    if (pending?.kind === "categories") {
      return categoryPickerView(current, ctx);
    }
    if (pending?.kind === "result") {
      return directResultView(current, pending.value, ctx, deps.registerAction);
    }
    try {
      return directResultView(current, current.resume(), ctx, deps.registerAction);
    } catch (error) {
      if (!(error instanceof PlacesServiceError) || error.code !== "NO_ACTIVE_INSERTION") {
        throw error;
      }
      return placesMenuView(ctx);
    }
  };

  return {
    id: PLACES_SECTION_ID,
    label: "📍 Places",
    order: 20,
    render,
    handleCallback: async (ctx: TelegramSectionCallbackContext) => {
      const current = requireService();
      switch (ctx.action) {
        case "menu":
          await ctx.edit(placesMenuView(ctx));
          await ctx.answerCallback();
          return "handled" as const;
        case "add":
          await ctx.answerCallback("Waiting for a place name.");
          await ctx.enqueuePrompt(
            'Ask me for the place name. After I answer, call places with action "categories" and pass that exact name.',
          );
          return "handled" as const;
        case "new-category":
          await ctx.answerCallback("Waiting for a category name.");
          await ctx.enqueuePrompt(
            'Ask me for the new place category name, then call places with action "create_category".',
          );
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
        case "category": {
          const draft = deps.getDraft();
          if (!draft) {
            await ctx.answerCallback("This add flow expired. Start again.");
            return "handled" as const;
          }
          deps.setDraft({ ...draft, categoryId: ctx.payload });
          await ctx.edit(sentimentView(ctx));
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "sentiment": {
          const draft = deps.getDraft();
          if (!draft?.categoryId || !["liked", "alright", "disliked"].includes(ctx.payload)) {
            await ctx.answerCallback("This add flow expired. Start again.");
            return "handled" as const;
          }
          deps.setDraft(undefined);
          const result = current.start({
            name: draft.name,
            categoryId: draft.categoryId,
            sentiment: ctx.payload as "liked" | "alright" | "disliked",
          });
          await ctx.edit(directResultView(current, result, ctx, deps.registerAction));
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "direct": {
          const action = deps.getAction(ctx.payload);
          if (!action) {
            await ctx.answerCallback("This button expired. Open /places again.");
            return "handled" as const;
          }
          let result: unknown;
          try {
            result = action.kind === "answer"
              ? current.answer({
                  insertionId: action.insertionId,
                  revision: action.revision,
                  existingPlaceId: action.existingPlaceId,
                  winner: action.winner,
                })
              : current.back(action.insertionId, action.revision);
          } catch (error) {
            if (!(error instanceof PlacesServiceError) || error.code !== "STALE_ACTION") throw error;
            try {
              result = current.resume();
            } catch {
              await ctx.edit(placesMenuView(ctx));
              await ctx.answerCallback("That comparison is no longer active.");
              return "handled" as const;
            }
          }
          await ctx.edit(directResultView(current, result, ctx, deps.registerAction));
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "cancel": {
          const active = current.resume();
          if (active.kind !== "compare" || active.insertionId !== ctx.payload) {
            await ctx.answerCallback("That comparison is no longer active.");
            return "handled" as const;
          }
          await ctx.edit({
            text: "<b>Cancel this unfinished ranking?</b>",
            replyMarkup: {
              inline_keyboard: [[{
                text: "🗑 Confirm cancel",
                callback_data: ctx.callbackData("confirm-cancel", active.insertionId),
              }]],
            },
          });
          await ctx.answerCallback();
          return "handled" as const;
        }
        case "confirm-cancel": {
          const active = current.resume();
          if (active.kind !== "compare" || active.insertionId !== ctx.payload) {
            await ctx.answerCallback("That comparison is no longer active.");
            return "handled" as const;
          }
          current.cancel(active.insertionId, active.revision);
          await ctx.edit(placesMenuView(ctx));
          await ctx.answerCallback("Cancelled.");
          return "handled" as const;
        }
        case "notes":
          await ctx.answerCallback("Waiting for notes.");
          await ctx.enqueuePrompt(
            `Ask me for notes, then call places with action "edit_place" and place_id ${JSON.stringify(ctx.payload)}.`,
          );
          return "handled" as const;
        case "manage":
          await ctx.answerCallback("Opening management.");
          await ctx.enqueuePrompt(
            `Show management options by calling places with action "place" and place_id ${JSON.stringify(ctx.payload)}.`,
          );
          return "handled" as const;
        default:
          return "pass" as const;
      }
    },
  };
}

function placesMenuView(ctx: TelegramSectionContext): TelegramSectionView {
  return {
    text: "<b>📍 Places</b>\n\nAdd a place or browse your rankings.",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "➕ Add place", callback_data: ctx.callbackData("add") }],
        [{ text: "🏆 View rankings", callback_data: ctx.callbackData("summaries") }],
        [{ text: "🛠 Manage places", callback_data: ctx.callbackData("summaries") }],
        [{ text: "➕ New category", callback_data: ctx.callbackData("new-category") }],
      ],
    },
  };
}

function categoryPickerView(service: PlacesService, ctx: TelegramSectionContext): TelegramSectionView {
  return {
    text: "<b>Choose a category</b>",
    replyMarkup: {
      inline_keyboard: [
        ...service.listCategories().map((category) => [{
          text: category.name,
          callback_data: ctx.callbackData("category", category.id),
        }]),
        [{ text: "➕ New category", callback_data: ctx.callbackData("new-category") }],
      ],
    },
  };
}

function sentimentView(ctx: TelegramSectionContext): TelegramSectionView {
  return {
    text: "<b>What was your overall impression?</b>",
    replyMarkup: {
      inline_keyboard: [[
        { text: "👍 Liked", callback_data: ctx.callbackData("sentiment", "liked") },
        { text: "👌 Alright", callback_data: ctx.callbackData("sentiment", "alright") },
        { text: "👎 Disliked", callback_data: ctx.callbackData("sentiment", "disliked") },
      ]],
    },
  };
}

function categorySummariesView(service: PlacesService, ctx: TelegramSectionContext): TelegramSectionView {
  const categories = service.listCategorySummaries();
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
  service: PlacesService,
  categoryId: string,
  offset: number,
  limit: number,
  ctx: TelegramSectionContext,
): TelegramSectionView {
  const category = service.listCategorySummaries().find((entry) => entry.id === categoryId);
  if (!category) throw new Error("That category no longer exists.");
  const ranking = service.listRanking(categoryId);
  const page = ranking.slice(offset, offset + limit);
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
  if (offset + limit < ranking.length) {
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

function placeView(service: PlacesService, placeId: string, ctx: TelegramSectionContext): TelegramSectionView {
  const place = service.getPlace(placeId);
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
  service: PlacesService,
  result: unknown,
  ctx: TelegramSectionContext,
  registerAction: (action: DirectAction) => string,
): TelegramSectionView {
  if (!result || typeof result !== "object") return placesMenuView(ctx);
  const value = result as Record<string, unknown>;
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

function invalid(message: string): PlacesServiceError {
  return new PlacesServiceError("INVALID_ACTION", message);
}

function toolResult(details: unknown, terminate = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
    ...(terminate ? { terminate: true } : {}),
  };
}
