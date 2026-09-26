import { PlacesOperationError } from "./places-errors.js";

export const PLACE_SENTIMENTS = ["liked", "alright", "disliked"] as const;

export type Sentiment = (typeof PLACE_SENTIMENTS)[number];

export interface RankedPlace {
  id: string;
  sentiment: Sentiment;
}

interface InsertionRange {
  low: number;
  high: number;
}

export interface PlaceInsertionState {
  version: 1;
  sentiment: Sentiment;
  rankingSnapshot: string[];
  bandStart: number;
  bandEnd: number;
  low: number;
  high: number;
  history: InsertionRange[];
}

export type PlaceInsertionStep =
  | {
      kind: "compare";
      index: number;
      existingPlaceId: string;
    }
  | {
      kind: "complete";
      index: number;
    };

export type PlaceComparisonWinner = "candidate" | "existing";

const SENTIMENT_ORDER = new Map<Sentiment, number>(
  PLACE_SENTIMENTS.map((sentiment, index) => [sentiment, index]),
);

function isSentiment(value: unknown): value is Sentiment {
  return PLACE_SENTIMENTS.includes(value as Sentiment);
}

function assertRanking(ranking: readonly RankedPlace[]): void {
  const ids = new Set<string>();
  let previousOrder = -1;

  for (const place of ranking) {
    if (typeof place.id !== "string" || place.id.length === 0) {
      throw new Error("Ranked place IDs must be non-empty strings");
    }
    if (ids.has(place.id)) {
      throw new Error(`Duplicate place ID in ranking: ${place.id}`);
    }
    ids.add(place.id);

    if (!isSentiment(place.sentiment)) {
      throw new Error("Ranked place has an invalid sentiment");
    }
    const order = SENTIMENT_ORDER.get(place.sentiment);
    if (order === undefined || order < previousOrder) {
      throw new Error("Ranking violates liked/alright/disliked sentiment order");
    }
    previousOrder = order;
  }
}

function rankingSnapshot(ranking: readonly RankedPlace[]): string[] {
  return ranking.map((place) => `${place.id}\u0000${place.sentiment}`);
}

function findBand(
  ranking: readonly RankedPlace[],
  sentiment: Sentiment,
): InsertionRange {
  const targetOrder = SENTIMENT_ORDER.get(sentiment);
  if (targetOrder === undefined) throw new Error("Invalid insertion sentiment");

  let low = ranking.length;
  let high = ranking.length;
  for (let index = 0; index < ranking.length; index += 1) {
    const place = ranking[index];
    if (!place) throw new PlacesOperationError("STALE_ACTION", "Ranking changed during insertion");
    const order = SENTIMENT_ORDER.get(place.sentiment);
    if (order === undefined) throw new Error("Ranked place has an invalid sentiment");
    if (order >= targetOrder && low === ranking.length) low = index;
    if (order > targetOrder) {
      high = index;
      break;
    }
  }
  if (low === ranking.length) {
    return { low: ranking.length, high: ranking.length };
  }
  return { low, high };
}

function assertRange(
  range: InsertionRange,
  bandStart: number,
  bandEnd: number,
): void {
  if (
    !Number.isInteger(range.low) ||
    !Number.isInteger(range.high) ||
    range.low < bandStart ||
    range.high > bandEnd ||
    range.low > range.high
  ) {
    throw new Error("Invalid insertion state range");
  }
}

function isNarrowedRange(previous: InsertionRange, next: InsertionRange): boolean {
  if (previous.low >= previous.high) return false;
  const midpoint = Math.floor((previous.low + previous.high) / 2);
  return (
    (next.low === previous.low && next.high === midpoint) ||
    (next.low === midpoint + 1 && next.high === previous.high)
  );
}

function assertState(
  ranking: readonly RankedPlace[],
  state: PlaceInsertionState,
): void {
  assertRanking(ranking);
  if (state.version !== 1 || !isSentiment(state.sentiment)) {
    throw new Error("Invalid insertion state version or sentiment");
  }

  const currentSnapshot = rankingSnapshot(ranking);
  if (
    currentSnapshot.length !== state.rankingSnapshot.length ||
    currentSnapshot.some((value, index) => value !== state.rankingSnapshot[index])
  ) {
    throw new PlacesOperationError("STALE_ACTION", "Ranking changed while insertion was in progress");
  }

  const band = findBand(ranking, state.sentiment);
  if (state.bandStart !== band.low || state.bandEnd !== band.high) {
    throw new PlacesOperationError("STALE_ACTION", "Ranking changed while insertion was in progress");
  }

  assertRange(state, state.bandStart, state.bandEnd);
  if (!Array.isArray(state.history)) {
    throw new Error("Invalid insertion state history");
  }

  let previous: InsertionRange | undefined;
  for (const [index, saved] of state.history.entries()) {
    assertRange(saved, state.bandStart, state.bandEnd);
    if (
      (index === 0 &&
        (saved.low !== state.bandStart || saved.high !== state.bandEnd)) ||
      (previous !== undefined && !isNarrowedRange(previous, saved))
    ) {
      throw new Error("Invalid insertion state history");
    }
    previous = saved;
  }
  if (previous !== undefined && !isNarrowedRange(previous, state)) {
    throw new Error("Invalid insertion state history");
  }
  if (
    state.history.length === 0 &&
    (state.low !== state.bandStart || state.high !== state.bandEnd)
  ) {
    throw new Error("Invalid insertion state range");
  }
}

export function createPlaceInsertion(
  ranking: readonly RankedPlace[],
  sentiment: Sentiment,
): PlaceInsertionState {
  assertRanking(ranking);
  if (!isSentiment(sentiment)) throw new Error("Invalid insertion sentiment");
  const band = findBand(ranking, sentiment);
  return {
    version: 1,
    sentiment,
    rankingSnapshot: rankingSnapshot(ranking),
    bandStart: band.low,
    bandEnd: band.high,
    low: band.low,
    high: band.high,
    history: [],
  };
}

export function getPlaceInsertionStep(
  ranking: readonly RankedPlace[],
  state: PlaceInsertionState,
): PlaceInsertionStep {
  assertState(ranking, state);
  if (state.low === state.high) return { kind: "complete", index: state.low };

  const index = Math.floor((state.low + state.high) / 2);
  const existing = ranking[index];
  if (!existing || existing.sentiment !== state.sentiment) {
    throw new Error("Invalid insertion state comparison target");
  }
  return { kind: "compare", index, existingPlaceId: existing.id };
}

export function answerPlaceComparison(
  ranking: readonly RankedPlace[],
  state: PlaceInsertionState,
  expectedExistingPlaceId: string,
  winner: PlaceComparisonWinner,
): PlaceInsertionState {
  const step = getPlaceInsertionStep(ranking, state);
  if (step.kind === "complete") {
    throw new Error("Place insertion is already complete");
  }
  if (step.existingPlaceId !== expectedExistingPlaceId) {
    throw new PlacesOperationError("STALE_ACTION", "Stale comparison target");
  }
  if (winner !== "candidate" && winner !== "existing") {
    throw new Error("Invalid comparison winner");
  }

  const saved = { low: state.low, high: state.high };
  return {
    ...state,
    low: winner === "candidate" ? state.low : step.index + 1,
    high: winner === "candidate" ? step.index : state.high,
    history: [...state.history, saved],
  };
}

export function undoPlaceComparison(
  state: PlaceInsertionState,
): PlaceInsertionState {
  const previous = state.history.at(-1);
  if (!previous) throw new Error("There is no comparison to undo");
  return {
    ...state,
    low: previous.low,
    high: previous.high,
    history: state.history.slice(0, -1),
  };
}

export function applyPlaceInsertion(
  ranking: readonly RankedPlace[],
  state: PlaceInsertionState,
  candidate: RankedPlace,
): RankedPlace[] {
  const step = getPlaceInsertionStep(ranking, state);
  if (step.kind !== "complete") {
    throw new Error("Place insertion still requires a comparison");
  }
  if (candidate.sentiment !== state.sentiment) {
    throw new Error("Candidate sentiment does not match insertion state");
  }
  if (ranking.some((place) => place.id === candidate.id)) {
    throw new Error(`Duplicate place ID in ranking: ${candidate.id}`);
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error("Candidate place ID must be a non-empty string");
  }

  return [
    ...ranking.slice(0, step.index),
    { ...candidate },
    ...ranking.slice(step.index),
  ];
}
