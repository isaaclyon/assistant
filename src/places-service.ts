import { randomUUID } from "node:crypto";

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
    };

function asServiceError(error: unknown): PlacesServiceError {
  if (error instanceof PlacesServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/stale|changed|revision/i.test(message)) {
    return new PlacesServiceError(
      "STALE_ACTION",
      "That ranking action is stale. Resume the current comparison and try again.",
      { cause: error },
    );
  }
  if (/unique constraint.*category\.normalized_name/i.test(message)) {
    return new PlacesServiceError("DUPLICATE_CATEGORY", "That category already exists.", {
      cause: error,
    });
  }
  if (/unique constraint.*place\.category_id.*place\.normalized_name/i.test(message)) {
    return new PlacesServiceError(
      "DUPLICATE_PLACE",
      "A place with that name already exists in this category.",
      { cause: error },
    );
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

  createCategory(name: string): PlaceCategory {
    const normalized = normalizePlaceName(name);
    if (this.listCategories().some((category) => category.normalizedName === normalized)) {
      throw new PlacesServiceError("DUPLICATE_CATEGORY", "That category already exists.");
    }
    try {
      return this.#store.createCategory(this.#createId(), name, this.#now());
    } catch (error) {
      throw asServiceError(error);
    }
  }

  listRanking(categoryId: string): StoredPlace[] {
    this.#requireCategory(categoryId);
    return this.#store.listPlaces(categoryId);
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
    const ranking = this.#store.listPlaces(insertion.categoryId);
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

  #next(insertion: ActiveInsertion): PlacesInteractionResult {
    const ranking = this.#store.listPlaces(insertion.categoryId);
    const category = this.#requireCategory(insertion.categoryId);
    const step = getPlaceInsertionStep(ranking, insertion.state);
    if (step.kind === "compare") {
      const existingPlace = ranking[step.index];
      if (!existingPlace || existingPlace.id !== step.existingPlaceId) {
        throw new PlacesServiceError("STALE_ACTION", "The ranking changed. Resume to continue.");
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
    };
  }

  #requireCategory(categoryId: string): PlaceCategory {
    const category = this.#store.listCategories().find((entry) => entry.id === categoryId);
    if (!category) throw new PlacesServiceError("NOT_FOUND", "That category no longer exists.");
    return category;
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
