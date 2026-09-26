import { PlacesApplication, type ConfirmationOperation } from "../../src/places-application.ts";
import { createPlacesSection, PLACE_RANKINGS_SECTION_ID, type DirectPendingView } from "../lib/places-section.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  presentTelegramSection,
  registerTelegramSection,
} from "@llblab/pi-telegram/sections";
import { join } from "node:path";
import { registerTelegramUpdateHandler } from "@llblab/pi-telegram/updates";
import { PlacesReply } from "../lib/places-reply.ts";
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

export default function placesExtension(pi: ExtensionAPI): void {
  let store: PlacesStore | undefined;
  let service: PlacesService | undefined;
  let unregisterSection: (() => void) | undefined;
  let unregisterReplies: (() => void) | undefined;
  const replies = new PlacesReply();
  let pendingDirectView: DirectPendingView | undefined;
  let draftAdd: { name: string; categoryId?: string } | undefined;
  let application: PlacesApplication | undefined;

  pi.on("session_start", () => {
    unregisterSection?.();
    unregisterSection = undefined;
    unregisterReplies?.();
    unregisterReplies = undefined;
    replies.clear();
    store?.close();
    store = undefined;
    service = undefined;
    application = undefined;
    pendingDirectView = undefined;
    draftAdd = undefined;
    const stateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR;
    const principal = process.env.PI_TELEGRAM_PRINCIPAL;
    const instanceId = process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID ?? "compatibility-singleton";
    if (!stateDir || principal !== "isaac") return;
    store = openPlacesStore(join(stateDir, "places.db"));
    service = new PlacesService(store, { ownerKey: `instance:${instanceId}:principal:${principal}` });
    application = new PlacesApplication(service);
    unregisterSection = registerTelegramSection(createPlacesSection({
      getApplication: () => application,
      replies,
      takePendingView: () => {
        const pending = pendingDirectView;
        pendingDirectView = undefined;
        return pending;
      },
      getDraft: () => draftAdd,
      setDraft: (draft) => {
        draftAdd = draft;
      },
    }));
    unregisterReplies = registerTelegramUpdateHandler((update) => replies.handle(update));
  });
  pi.on("session_shutdown", () => {
    unregisterReplies?.();
    unregisterReplies = undefined;
    replies.clear();
    unregisterSection?.();
    unregisterSection = undefined;
    store?.close();
    store = undefined;
    service = undefined;
    application = undefined;
    pendingDirectView = undefined;
    draftAdd = undefined;
  });

  registerReloadSafeTelegramCommand({
    name: "place_rankings",
    description: "Add, compare, and view your private place rankings.",
    showInMenu: true,
    emoji: "📍",
    handler: async (ctx) => {
      await ctx.openSection(PLACE_RANKINGS_SECTION_ID);
    },
  });

  pi.registerTool({
    name: "rank_places",
    label: "Place Rankings",
    description:
      "Maintain the user's private restaurant, coffee-shop, bar, and other place rankings. Supports categories, adding a place, durable pairwise comparisons, resume/cancel, and paginated rankings.",
    promptSnippet: "Add, compare, resume, cancel, or list private place rankings",
    promptGuidelines: [
      "Use rank_places whenever the user asks to add, rank, compare, resume, cancel, or list restaurants, coffee shops, bars, or other saved places.",
      "When adding a place from Telegram, collect its name, then call rank_places with action categories and that name; the direct Telegram section owns category, sentiment, and comparison buttons.",
      "Render each returned buttonActions entry exactly as a telegram_button prompt action, keep the visible text short, and never invent ranking state.",
      "Before delete_place, delete_category, undo_addition, or cancel, call request_confirmation and render its exact Confirm button; only that token authorizes the action.",
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
        const result = application!.execute(params);
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
                { label: "View existing", prompt: `Show details by calling rank_places with action "place" and place_id ${JSON.stringify(existing.id)}.` },
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
    await presentTelegramSection(PLACE_RANKINGS_SECTION_ID);
    return true;
  } catch {
    return false;
  }
}

function addButtonActions(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  if (value.kind === "confirmation") {
    return { ...value, buttonActions: [{ label: "Confirm", prompt: destructivePrompt(value.operation as ConfirmationOperation, value.params as ConfirmationParams, String(value.token)) }] };
  }
  if (Array.isArray(value.categories)) {
    const active = value.active ? addButtonActions(value.active) : undefined;
    const categoryButtons = value.categories.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const category = entry as { id?: unknown; name?: unknown };
      if (typeof category.id !== "string" || typeof category.name !== "string") return [];
      return [{
        label: category.name,
        prompt: `Open ${JSON.stringify(category.name)} by calling rank_places with action "ranking" and category_id ${JSON.stringify(category.id)}.`,
      }];
    });
    if ("active" in value) {
      return {
        ...value,
        ...(active ? { active } : {}),
        buttonActions: [
          { label: "Resume ranking", prompt: 'Resume my unfinished ranking by calling rank_places with action "resume" and use the returned exact buttons.' },
          { label: "Cancel ranking", prompt: 'Call rank_places with action "resume", then request an operation-bound cancel confirmation for its insertion ID and revision.' },
          { label: "View rankings", prompt: 'Call rank_places with action "category_summaries" and render every returned category button.' },
        ],
      };
    }
    const summaries = value.categories.some((entry) => entry && typeof entry === "object" && "placeCount" in entry);
    if (summaries) {
      categoryButtons.push(
        { label: "New category", prompt: 'Ask me for the category name, then call rank_places with action "create_category".' },
        { label: "Manage categories", prompt: 'Ask which category to rename or delete. Use rename_category directly; for deletion request an operation-bound delete_category confirmation and note that only empty categories can be deleted.' },
      );
    }
    return {
      ...value,
      buttonActions: summaries
        ? categoryButtons
        : [
            { label: "Add place", prompt: 'Ask me for the place name, then call rank_places with action "categories" and continue through category, sentiment, and optional notes before action "start".' },
            { label: "View rankings", prompt: 'Call rank_places with action "category_summaries" and render every returned category button.' },
            { label: "Manage places", prompt: 'Call rank_places with action "category_summaries", ask which category to manage, then show its ranking with place-detail buttons.' },
            { label: "New category", prompt: 'Ask me for the new category name, then call rank_places with action "create_category".' },
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
      return [{ label: place.name, prompt: `Show details by calling rank_places with action "place" and place_id ${JSON.stringify(place.id)}.` }];
    });
    if (value.hasPrevious === true) actions.push({ label: "Previous", prompt: `Call rank_places with action "ranking", category_id ${JSON.stringify(value.categoryId)}, offset ${Math.max(0, offset - limit)}, and limit ${limit}.` });
    if (value.hasNext === true) actions.push({ label: "Next", prompt: `Call rank_places with action "ranking", category_id ${JSON.stringify(value.categoryId)}, offset ${offset + limit}, and limit ${limit}.` });
    return { ...value, buttonActions: actions };
  }
  if (value.kind !== "complete" && value.place && typeof value.place === "object") {
    const place = value.place as { id?: unknown; name?: unknown; categoryId?: unknown; sentiment?: unknown };
    if (typeof place.id === "string") {
      return {
        ...value,
        buttonActions: [
          { label: "Edit name or notes", prompt: `Ask what to change, then call rank_places with action "edit_place" and place_id ${JSON.stringify(place.id)}.` },
          { label: "Move", prompt: `Call rank_places with action "categories", ask for the target category, then call rank_places with action "reposition" and place_id ${JSON.stringify(place.id)}.` },
          { label: "Re-rank", prompt: `Ask for the sentiment, then call rank_places with action "reposition" and place_id ${JSON.stringify(place.id)} using the current category.` },
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
        prompt: `Show this place ranking by calling rank_places with action "ranking" and category_id ${JSON.stringify(categoryId)}.`,
      });
    }
    const place = value.place;
    const placeId = place && typeof place === "object" ? (place as { id?: unknown }).id : undefined;
    if (typeof placeId === "string") {
      buttonActions.unshift({
        label: "Add notes",
        prompt: `Ask me for notes, then call rank_places with action "edit_place" and place_id ${JSON.stringify(placeId)} using those notes.`,
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
    `Continue my place ranking by calling rank_places with action "answer", insertion_id ${JSON.stringify(insertionId)}, revision ${revision}, existing_place_id ${JSON.stringify(existingId)}, and winner "${winner}". Use the returned exact next step.`;
  const buttonActions = [
    { label: candidateName, prompt: answerPrompt("candidate") },
    { label: existingName, prompt: answerPrompt("existing") },
  ];
  if (revision > 0) {
    buttonActions.push({
      label: "Back",
      prompt: `Go back one place comparison by calling rank_places with action "back", insertion_id ${JSON.stringify(insertionId)}, and revision ${revision}. Use the returned exact step.`,
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

type ConfirmationParams = { insertion_id?: string; revision?: number; place_id?: string; category_id?: string };

function destructivePrompt(operation: ConfirmationOperation, params: ConfirmationParams, token: string): string {
  const fields = operation === "cancel"
    ? `insertion_id ${JSON.stringify(params.insertion_id)} and revision ${params.revision}`
    : operation === "delete_place"
      ? `place_id ${JSON.stringify(params.place_id)}`
      : operation === "delete_category"
        ? `category_id ${JSON.stringify(params.category_id)}`
        : `insertion_id ${JSON.stringify(params.insertion_id)}`;
  return `Confirm now by calling rank_places with action ${JSON.stringify(operation)}, ${fields}, and confirmation_token ${JSON.stringify(token)}. Use it once and report the exact result.`;
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
