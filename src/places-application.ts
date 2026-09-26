import { randomUUID } from "node:crypto";
import { PlacesService, PlacesServiceError } from "./places-service.js";
import type { PlaceDeletionSnapshot } from "./places-store.js";

export type ConfirmationOperation = "cancel" | "delete_place" | "delete_category" | "undo_addition";
// Parsed tool fields and direct UI actions meet here; operation-specific guards
// convert optional transport fields into the service's required domain inputs.
export interface PlacesCommand {
  action: "menu" | "categories" | "category_summaries" | "create_category" | "rename_category" | "delete_category" | "start" | "place" | "edit_place" | "delete_place" | "reposition" | "undo_addition" | "request_confirmation" | "resume" | "answer" | "back" | "cancel" | "ranking";
  name?: string;
  category_id?: string;
  place_id?: string;
  sentiment?: "liked" | "alright" | "disliked";
  notes?: string;
  insertion_id?: string;
  revision?: number;
  existing_place_id?: string;
  winner?: "candidate" | "existing";
  offset?: number;
  limit?: number;
  confirmation_operation?: ConfirmationOperation;
  confirmation_token?: string;
}

type Confirmation = { operation: ConfirmationOperation; target: string; expiresAt: number; snapshot?: PlaceDeletionSnapshot };

export class PlacesApplication {
  private readonly confirmations = new Map<string, Confirmation>();
  constructor(private readonly service: PlacesService, private readonly now = Date.now) {}
  execute(params: PlacesCommand & { action: "categories" }): { categories: ReturnType<PlacesService["listCategories"]> };
  execute(params: PlacesCommand & { action: "category_summaries" }): { categories: ReturnType<PlacesService["listCategorySummaries"]> };
  execute(params: PlacesCommand & { action: "place" }): { place: ReturnType<PlacesService["getPlace"]> };
  execute(params: PlacesCommand & { action: "resume" }): ReturnType<PlacesService["resume"]>;
  execute(params: PlacesCommand & { action: "ranking" }): Extract<PlacesApplicationResult, { places: unknown[] }>;
  execute(params: PlacesCommand): PlacesApplicationResult;
  execute(params: PlacesCommand): PlacesApplicationResult { return this.dispatch(params); }

  private dispatch(params: PlacesCommand) {
    if (params.notes !== undefined && params.notes.length > 4000) throw invalid("Notes must be at most 4000 characters");
    const service = this.service;
    const confirmations = this.confirmations;
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
        return { categories: service.listCategories(), ...(active ? { active } : {}) };
      }
      case "categories":
        return { categories: service.listCategories() };
      case "category_summaries":
        return { categories: service.listCategorySummaries() };
      case "create_category":
        if (!params.name) throw invalid("create_category requires name");
        return { category: service.createCategory(params.name) };
      case "rename_category":
        if (!params.category_id || !params.name) {
          throw invalid("rename_category requires category_id and name");
        }
        return { category: service.renameCategory(params.category_id, params.name) };
      case "delete_category":
        if (!params.category_id) throw invalid("delete_category requires category_id");
        service.deleteCategory(params.category_id, consumeConfirmation(confirmations, this.now(), params.confirmation_token, "delete_category", params.category_id).snapshot);
        return { deleted: true };
      case "start":
        if (!params.name || !params.category_id || !params.sentiment) {
          throw invalid("start requires name, category_id, and sentiment");
        }
        return service.start({
          name: params.name,
          categoryId: params.category_id,
          sentiment: params.sentiment,
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
        });
      case "place":
        if (!params.place_id) throw invalid("place requires place_id");
        return { place: service.getPlace(params.place_id) };
      case "edit_place":
        if (!params.place_id || (params.name === undefined && params.notes === undefined)) {
          throw invalid("edit_place requires place_id and name or notes");
        }
        return {
          place: service.editPlace(params.place_id, {
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.notes !== undefined ? { notes: params.notes } : {}),
          }),
        };
      case "delete_place":
        if (!params.place_id) throw invalid("delete_place requires place_id");
        service.deletePlace(params.place_id, consumeConfirmation(confirmations, this.now(), params.confirmation_token, "delete_place", params.place_id).snapshot);
        return { deleted: true };
      case "reposition":
        if (!params.place_id) throw invalid("reposition requires place_id");
        return service.reposition(params.place_id, {
          ...(params.category_id !== undefined ? { categoryId: params.category_id } : {}),
          ...(params.sentiment !== undefined ? { sentiment: params.sentiment } : {}),
        });
      case "undo_addition":
        if (!params.insertion_id) throw invalid("undo_addition requires insertion_id");
        consumeConfirmation(confirmations, this.now(), params.confirmation_token, "undo_addition", params.insertion_id);
        service.undoAddition(params.insertion_id);
        return { undone: true };
      case "request_confirmation": {
        if (!params.confirmation_operation) throw invalid("request_confirmation requires confirmation_operation");
        const target = confirmationTarget(params.confirmation_operation, params);
        const now = this.now();
        for (const [existingToken, confirmation] of confirmations) {
          if (confirmation.expiresAt <= now) confirmations.delete(existingToken);
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
          ...(params.confirmation_operation === "delete_place" || params.confirmation_operation === "delete_category"
            ? { snapshot: service.deletionSnapshot(params.confirmation_operation === "delete_place" ? "place" : "category", target) } : {}),
        });
        return {
          kind: "confirmation" as const,
          operation: params.confirmation_operation,
          token,
          params,
        };
      }
      case "resume":
        return service.resume();
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
        return service.answer({
          insertionId: params.insertion_id,
          revision: params.revision,
          existingPlaceId: params.existing_place_id,
          winner: params.winner,
        });
      case "back":
        if (!params.insertion_id || params.revision === undefined) {
          throw invalid("back requires insertion_id and revision");
        }
        return service.back(params.insertion_id, params.revision);
      case "cancel":
        if (!params.insertion_id || params.revision === undefined) {
          throw invalid("cancel requires insertion_id and revision");
        }
        consumeConfirmation(confirmations, this.now(), params.confirmation_token, "cancel", `${params.insertion_id}:${params.revision}`);
        service.cancel(params.insertion_id, params.revision);
        return { cancelled: true };
      case "ranking": {
        if (!params.category_id) throw invalid("ranking requires category_id");
        const ranking = service.listRanking(params.category_id);
        const offset = params.offset ?? 0;
        const limit = params.limit ?? 25;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid("Invalid ranking page");
        return {
          categoryId: params.category_id,
          offset,
          limit,
          total: ranking.length,
          places: ranking.slice(offset, offset + limit),
          hasPrevious: offset > 0,
          hasNext: offset + limit < ranking.length,
        };
      }
    }
  }
}

export type PlacesApplicationResult = ReturnType<PlacesApplication["dispatch"]>;

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

function consumeConfirmation(
  confirmations: Map<string, Confirmation>,
  now: number,
  token: string | undefined,
  operation: ConfirmationOperation,
  target: string,
): Confirmation {
  if (!token) throw invalid(`${operation} requires an operation-bound confirmation token`);
  const confirmation = confirmations.get(token);
  confirmations.delete(token);
  if (!confirmation || confirmation.expiresAt <= now || confirmation.operation !== operation || confirmation.target !== target) {
    throw invalid("That confirmation is missing, expired, already used, or belongs to another operation");
  }
  return confirmation;
}


function invalid(message: string): PlacesServiceError { return new PlacesServiceError("INVALID_ACTION", message); }
