import { randomUUID } from "node:crypto";
import { PlacesOperationError } from "./places-errors.js";

import {
  answerPlaceComparison,
  createPlaceInsertion,
  getPlaceInsertionStep,
  type PlaceComparisonWinner,
  type Sentiment,
} from "./places-ranking.js";
import {
  normalizePlaceName,
  type ActiveInsertion,
  type PlaceCategory,
  type PlacesStore,
  type StoredPlace,
  type PlaceDeletionSnapshot,
} from "./places-store.js";

export type PlacesServiceErrorCode =
  | "ACTIVE_INSERTION_EXISTS"
  | "NO_ACTIVE_INSERTION"
  | "DUPLICATE_PLACE"
  | "DUPLICATE_CATEGORY"
  | "STALE_ACTION"
  | "INVALID_ACTION"
  | "NOT_FOUND"
  | "PERSISTENCE_ERROR";

export class PlacesServiceError extends Error {
  readonly code: PlacesServiceErrorCode;

  constructor(code: PlacesServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlacesServiceError";
    this.code = code;
  }
}

export interface PlacesServiceOptions {
  ownerKey: string;
  now?: () => number;
  createId?: () => string;
}

export interface StartPlaceInput {
  name: string;
  categoryId: string;
  sentiment: Sentiment;
  notes?: string | null;
}

export interface AnswerPlaceInput {
  insertionId: string;
  revision: number;
  existingPlaceId: string;
  winner: PlaceComparisonWinner;
}

export type PlacesInteractionResult =
  | {
      kind: "compare";
      insertionId: string;
      revision: number;
      candidate: { id: string; name: string };
      existingPlace: StoredPlace;
      category: PlaceCategory;
    }
  | {
      kind: "complete";
      place: StoredPlace;
      category: PlaceCategory;
      rank: number;
      total: number;
      undoInsertionId?: string;
    };

export interface RepositionPlaceInput {
  categoryId?: string;
  sentiment?: Sentiment;
}

function asServiceError(error: unknown): PlacesServiceError {
  if (error instanceof PlacesServiceError) return error;
  if (error instanceof PlacesOperationError) {
    const messages = {
      STALE_ACTION: "That ranking action is stale. Resume the current comparison and try again.",
      DUPLICATE_CATEGORY: "That category already exists.",
      DUPLICATE_PLACE: "A place with that name already exists in this category.",
      INVALID_ACTION: error.message,
    };
    return new PlacesServiceError(error.code, messages[error.code], { cause: error });
  }
  return new PlacesServiceError(
    "PERSISTENCE_ERROR",
    "The places database could not accept that action. Nothing was changed.",
    { cause: error },
  );
}

export class PlacesService {
  readonly #store: PlacesStore;
  readonly #ownerKey: string;
  readonly #now: () => number;
  readonly #createId: () => string;

  constructor(store: PlacesStore, options: PlacesServiceOptions) {
    this.#store = store;
    this.#ownerKey = options.ownerKey;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }

  listCategories(): PlaceCategory[] {
    return this.#store.listCategories();
  }

  listCategorySummaries(): Array<PlaceCategory & { placeCount: number }> {
    return this.listCategories().map((category) => ({
      ...category,
      placeCount: this.#store.listPlaces(category.id).length,
    }));
  }

  createCategory(name: string): PlaceCategory {
    try {
      return this.#store.createCategory(this.#createId(), name, this.#now());
    } catch (error) {
      throw asServiceError(error);
    }
  }

  renameCategory(id: string, name: string): PlaceCategory {
    this.#requireCategory(id);
    try {
      return this.#store.renameCategory(id, name, this.#now());
    } catch (error) {
      throw asServiceError(error);
    }
  }

  deletionSnapshot(kind: "place" | "category", id: string): PlaceDeletionSnapshot {
    try { return this.#store.deletionSnapshot(kind, id); }
    catch (error) { throw asServiceError(error); }
  }

  deleteCategory(id: string, expected?: PlaceDeletionSnapshot): void {
    this.#requireCategory(id);
    try {
      this.#store.deleteCategory(id, expected);
    } catch (error) {
      throw asServiceError(error);
    }
  }

  listRanking(categoryId: string): StoredPlace[] {
    this.#requireCategory(categoryId);
    return this.#store.listPlaces(categoryId);
  }

  getPlace(id: string): StoredPlace {
    const place = this.#store.getPlace(id);
    if (!place) throw new PlacesServiceError("NOT_FOUND", "That place no longer exists.");
    return place;
  }

  editPlace(
    id: string,
    changes: { name?: string; notes?: string | null },
  ): StoredPlace {
    this.getPlace(id);
    try {
      return this.#store.updatePlace(id, changes, this.#now());
    } catch (error) {
      throw asServiceError(error);
    }
  }

  deletePlace(id: string, expected?: PlaceDeletionSnapshot): void {
    this.getPlace(id);
    try {
      this.#store.deletePlace(id, expected);
    } catch (error) {
      throw asServiceError(error);
    }
  }

  start(input: StartPlaceInput): PlacesInteractionResult {
    if (this.#store.getActiveInsertion(this.#ownerKey)) {
      throw new PlacesServiceError(
        "ACTIVE_INSERTION_EXISTS",
        "Another place ranking is unfinished. Resume or cancel it first.",
      );
    }
    const category = this.#requireCategory(input.categoryId);
    const ranking = this.#store.listPlaces(input.categoryId);
    const normalized = normalizePlaceName(input.name);
    if (ranking.some((place) => place.normalizedName === normalized)) {
      throw new PlacesServiceError(
        "DUPLICATE_PLACE",
        "A place with that name already exists in this category.",
      );
    }

    const insertionId = this.#createId();
    const candidateId = this.#createId();
    const state = createPlaceInsertion(ranking, input.sentiment);
    try {
      const insertion = this.#store.createInsertion({
        id: insertionId,
        ownerKey: this.#ownerKey,
        candidateId,
        name: input.name,
        categoryId: category.id,
        sentiment: input.sentiment,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        state,
        now: this.#now(),
      });
      return this.#next(insertion);
    } catch (error) {
      throw asServiceError(error);
    }
  }

  reposition(placeId: string, input: RepositionPlaceInput): PlacesInteractionResult {
    if (this.#store.getActiveInsertion(this.#ownerKey)) {
      throw new PlacesServiceError(
        "ACTIVE_INSERTION_EXISTS",
        "Another place ranking is unfinished. Resume or cancel it first.",
      );
    }
    const source = this.getPlace(placeId);
    const category = this.#requireCategory(input.categoryId ?? source.categoryId);
    const sentiment = input.sentiment ?? source.sentiment;
    const ranking = this.#store
      .listPlaces(category.id)
      .filter((place) => place.id !== source.id);
    if (
      ranking.some((place) => place.normalizedName === source.normalizedName)
    ) {
      throw new PlacesServiceError(
        "DUPLICATE_PLACE",
        "A place with that name already exists in the target category.",
      );
    }
    const insertionId = this.#createId();
    try {
      const insertion = this.#store.createInsertion({
        id: insertionId,
        ownerKey: this.#ownerKey,
        candidateId: source.id,
        name: source.name,
        categoryId: category.id,
        sentiment,
        notes: source.notes,
        sourcePlaceId: source.id,
        state: createPlaceInsertion(ranking, sentiment),
        now: this.#now(),
      });
      return this.#next(insertion);
    } catch (error) {
      throw asServiceError(error);
    }
  }

  resume(): PlacesInteractionResult {
    const insertion = this.#store.getActiveInsertion(this.#ownerKey);
    if (!insertion) {
      throw new PlacesServiceError("NO_ACTIVE_INSERTION", "There is no unfinished ranking.");
    }
    try {
      return this.#next(insertion);
    } catch (error) {
      throw asServiceError(error);
    }
  }

  answer(input: AnswerPlaceInput): PlacesInteractionResult {
    const insertion = this.#requireActive(input.insertionId, input.revision);
    const ranking = this.#store
      .listPlaces(insertion.categoryId)
      .filter((place) => place.id !== insertion.sourcePlaceId);
    try {
      const state = answerPlaceComparison(
        ranking,
        insertion.state,
        input.existingPlaceId,
        input.winner,
      );
      const updated = this.#store.recordComparison({
        insertionId: insertion.id,
        expectedRevision: insertion.revision,
        actionId: `answer:${insertion.id}:${insertion.revision}:${input.existingPlaceId}:${input.winner}`,
        existingPlaceId: input.existingPlaceId,
        winner: input.winner,
        state,
        now: this.#now(),
      });
      return this.#next(updated);
    } catch (error) {
      throw asServiceError(error);
    }
  }

  back(insertionId: string, revision: number): PlacesInteractionResult {
    this.#requireActive(insertionId, revision);
    try {
      const updated = this.#store.undoComparison({
        insertionId,
        expectedRevision: revision,
        actionId: `back:${insertionId}:${revision}`,
        now: this.#now(),
      });
      return this.#next(updated);
    } catch (error) {
      throw asServiceError(error);
    }
  }

  cancel(insertionId: string, revision: number): void {
    this.#requireActive(insertionId, revision);
    try {
      this.#store.cancelInsertion(insertionId, revision, this.#now());
    } catch (error) {
      throw asServiceError(error);
    }
  }

  undoAddition(insertionId: string): void {
    try {
      this.#store.undoAddition(insertionId, this.#now());
    } catch (error) {
      throw asServiceError(error);
    }
  }

  #next(insertion: ActiveInsertion): PlacesInteractionResult {
    const ranking = this.#store
      .listPlaces(insertion.categoryId)
      .filter((place) => place.id !== insertion.sourcePlaceId);
    const category = this.#requireCategory(insertion.categoryId);
    let step: ReturnType<typeof getPlaceInsertionStep>;
    try {
      step = getPlaceInsertionStep(ranking, insertion.state);
    } catch (error) {
      this.#cancelChangedInsertion(insertion);
      throw new PlacesServiceError(
        "STALE_ACTION",
        "The category changed during ranking. The unfinished operation was cancelled; start it again.",
        { cause: error },
      );
    }
    if (step.kind === "compare") {
      const existingPlace = ranking[step.index];
      if (!existingPlace || existingPlace.id !== step.existingPlaceId) {
        this.#cancelChangedInsertion(insertion);
        throw new PlacesServiceError(
          "STALE_ACTION",
          "The category changed during ranking. The unfinished operation was cancelled; start it again.",
        );
      }
      return {
        kind: "compare",
        insertionId: insertion.id,
        revision: insertion.revision,
        candidate: { id: insertion.candidateId, name: insertion.name },
        existingPlace,
        category,
      };
    }
    const place = this.#store.completeInsertion({
      insertionId: insertion.id,
      expectedRevision: insertion.revision,
      actionId: `complete:${insertion.id}:${insertion.revision}`,
      index: step.index,
      now: this.#now(),
    });
    return {
      kind: "complete",
      place,
      category,
      rank: place.position + 1,
      total: ranking.length + 1,
      ...(insertion.sourcePlaceId === null
        ? { undoInsertionId: insertion.id }
        : {}),
    };
  }

  #requireCategory(categoryId: string): PlaceCategory {
    const category = this.#store.listCategories().find((entry) => entry.id === categoryId);
    if (!category) throw new PlacesServiceError("NOT_FOUND", "That category no longer exists.");
    return category;
  }

  #cancelChangedInsertion(insertion: ActiveInsertion): void {
    try {
      this.#store.cancelInsertion(insertion.id, insertion.revision, this.#now());
    } catch (error) {
      const current = this.#store.getActiveInsertion(this.#ownerKey);
      if (!current) return;
      if (current.id !== insertion.id || current.revision !== insertion.revision) {
        throw new PlacesServiceError(
          "STALE_ACTION",
          "The ranking changed again. Resume the current operation.",
          { cause: error },
        );
      }
      throw asServiceError(error);
    }
  }

  #requireActive(insertionId: string, revision: number): ActiveInsertion {
    const insertion = this.#store.getActiveInsertion(this.#ownerKey);
    if (!insertion) {
      throw new PlacesServiceError("NO_ACTIVE_INSERTION", "There is no unfinished ranking.");
    }
    if (insertion.id !== insertionId || insertion.revision !== revision) {
      throw new PlacesServiceError(
        "STALE_ACTION",
        "That ranking action is stale. Resume the current comparison.",
      );
    }
    return insertion;
  }
}
