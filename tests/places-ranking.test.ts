import { describe, expect, it } from "vitest";

import {
  answerPlaceComparison,
  applyPlaceInsertion,
  createPlaceInsertion,
  getPlaceInsertionStep,
  undoPlaceComparison,
  type PlaceInsertionState,
  type RankedPlace,
  type Sentiment,
} from "../src/places-ranking.js";

function places(count: number, sentiment: Sentiment = "liked"): RankedPlace[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${sentiment}-${index}`,
    sentiment,
  }));
}

function finishAt(
  ranking: readonly RankedPlace[],
  sentiment: Sentiment,
  desiredIndex: number,
): { state: PlaceInsertionState; comparisons: number; comparedIds: string[] } {
  let state = createPlaceInsertion(ranking, sentiment);
  let comparisons = 0;
  const comparedIds: string[] = [];

  while (true) {
    const step = getPlaceInsertionStep(ranking, state);
    if (step.kind === "complete") {
      expect(step.index).toBe(desiredIndex);
      return { state, comparisons, comparedIds };
    }

    comparisons += 1;
    comparedIds.push(step.existingPlaceId);
    state = answerPlaceComparison(
      ranking,
      state,
      step.existingPlaceId,
      desiredIndex <= step.index ? "candidate" : "existing",
    );
  }
}

describe("place ranking insertion", () => {
  it("finds every insertion position with a logarithmic number of comparisons", () => {
    for (let size = 0; size <= 32; size += 1) {
      const ranking = places(size);
      for (let desiredIndex = 0; desiredIndex <= size; desiredIndex += 1) {
        const result = finishAt(ranking, "liked", desiredIndex);
        expect(result.comparisons).toBeLessThanOrEqual(
          Math.ceil(Math.log2(size + 1)),
        );
      }
    }
  });

  it("compares only inside the selected contiguous sentiment band", () => {
    const ranking = [
      ...places(2, "liked"),
      ...places(3, "alright"),
      ...places(2, "disliked"),
    ];

    const first = finishAt(ranking, "alright", 2);
    const middle = finishAt(ranking, "alright", 4);
    const last = finishAt(ranking, "alright", 5);

    for (const result of [first, middle, last]) {
      expect(result.comparedIds.length).toBeGreaterThan(0);
      expect(result.comparedIds.every((id) => id.startsWith("alright-"))).toBe(
        true,
      );
    }
  });

  it("completes without a comparison when the selected band is empty", () => {
    const ranking = [...places(2, "liked"), ...places(2, "disliked")];
    const state = createPlaceInsertion(ranking, "alright");

    expect(getPlaceInsertionStep(ranking, state)).toEqual({
      kind: "complete",
      index: 2,
    });
  });

  it("restores the exact prior comparison when the latest answer is undone", () => {
    const ranking = places(8);
    const initial = createPlaceInsertion(ranking, "liked");
    const first = getPlaceInsertionStep(ranking, initial);
    expect(first.kind).toBe("compare");
    if (first.kind !== "compare") throw new Error("expected comparison");

    const answered = answerPlaceComparison(
      ranking,
      initial,
      first.existingPlaceId,
      "candidate",
    );
    const restored = undoPlaceComparison(answered);

    expect(getPlaceInsertionStep(ranking, restored)).toEqual(first);
    expect(() => undoPlaceComparison(restored)).toThrow(/no comparison to undo/i);
  });

  it("can resume from serialized insertion state", () => {
    const ranking = places(10);
    const initial = createPlaceInsertion(ranking, "liked");
    const first = getPlaceInsertionStep(ranking, initial);
    if (first.kind !== "compare") throw new Error("expected comparison");
    const answered = answerPlaceComparison(
      ranking,
      initial,
      first.existingPlaceId,
      "existing",
    );
    const restored = JSON.parse(JSON.stringify(answered)) as PlaceInsertionState;

    expect(getPlaceInsertionStep(ranking, restored)).toEqual(
      getPlaceInsertionStep(ranking, answered),
    );
  });

  it("applies a completed insertion without mutating the existing ranking", () => {
    const ranking = places(3);
    const { state } = finishAt(ranking, "liked", 1);

    const inserted = applyPlaceInsertion(ranking, state, {
      id: "candidate",
      sentiment: "liked",
    });

    expect(ranking.map((place) => place.id)).toEqual([
      "liked-0",
      "liked-1",
      "liked-2",
    ]);
    expect(inserted.map((place) => place.id)).toEqual([
      "liked-0",
      "candidate",
      "liked-1",
      "liked-2",
    ]);
  });

  it("rejects malformed rankings, state, stale targets, and duplicate candidates", () => {
    expect(() =>
      createPlaceInsertion(
        [
          { id: "a", sentiment: "alright" },
          { id: "b", sentiment: "liked" },
        ],
        "liked",
      ),
    ).toThrow(/sentiment order/i);
    expect(() =>
      createPlaceInsertion(
        [
          { id: "same", sentiment: "liked" },
          { id: "same", sentiment: "liked" },
        ],
        "liked",
      ),
    ).toThrow(/duplicate place id/i);

    const ranking = places(4);
    const state = createPlaceInsertion(ranking, "liked");
    const step = getPlaceInsertionStep(ranking, state);
    if (step.kind !== "compare") throw new Error("expected comparison");

    expect(() =>
      answerPlaceComparison(ranking, state, "different-id", "candidate"),
    ).toThrow(/stale comparison target/i);
    expect(() =>
      getPlaceInsertionStep(ranking.slice(1), state),
    ).toThrow(/ranking changed/i);
    expect(() =>
      getPlaceInsertionStep(ranking, { ...state, low: -1 }),
    ).toThrow(/invalid insertion state/i);

    const completed = finishAt(ranking, "liked", 2).state;
    expect(() =>
      applyPlaceInsertion(ranking, completed, {
        id: "liked-0",
        sentiment: "liked",
      }),
    ).toThrow(/duplicate place id/i);
    expect(() =>
      applyPlaceInsertion(ranking, completed, {
        id: "new",
        sentiment: "alright",
      }),
    ).toThrow(/candidate sentiment/i);
  });
});
