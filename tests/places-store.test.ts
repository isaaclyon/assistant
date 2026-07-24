import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  answerPlaceComparison,
  createPlaceInsertion,
  getPlaceInsertionStep,
} from "../src/places-ranking.js";
import { openPlacesStore, type PlacesStore } from "../src/places-store.js";

describe("places SQLite store", () => {
  let root: string;
  let dbPath: string;
  let store: PlacesStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "places-store-"));
    dbPath = join(root, "places.db");
    store = openPlacesStore(dbPath);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("initializes a private versioned database with default categories", async () => {
    expect(store.schemaVersion).toBe(2);
    expect(store.listCategories().map((category) => category.name)).toEqual([
      "Restaurants",
      "Coffee",
      "Bars",
    ]);
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps ranked positions contiguous across insert, delete, and reopen", () => {
    const categoryId = store.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    store.insertPlace({ id: "a", categoryId, name: "A", sentiment: "liked", index: 0, now: 1 });
    store.insertPlace({ id: "c", categoryId, name: "C", sentiment: "liked", index: 1, now: 2 });
    store.insertPlace({ id: "b", categoryId, name: "B", sentiment: "liked", index: 1, now: 3 });
    store.deletePlace("b");
    store.close();

    store = openPlacesStore(dbPath);
    expect(store.listPlaces(categoryId).map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "a", position: 0 },
      { id: "c", position: 1 },
    ]);
  });

  it("persists active insertion state and records each answer atomically and idempotently", () => {
    const categoryId = store.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    store.insertPlace({ id: "a", categoryId, name: "A", sentiment: "liked", index: 0, now: 1 });
    store.insertPlace({ id: "b", categoryId, name: "B", sentiment: "liked", index: 1, now: 2 });
    const ranking = store.listPlaces(categoryId);
    const state = createPlaceInsertion(ranking, "liked");
    const step = getPlaceInsertionStep(ranking, state);
    if (step.kind !== "compare") throw new Error("expected comparison");

    store.createInsertion({
      id: "insertion-1",
      ownerKey: "chat:actor",
      candidateId: "candidate",
      name: "Candidate",
      categoryId,
      sentiment: "liked",
      state,
      now: 3,
    });
    const next = answerPlaceComparison(ranking, state, step.existingPlaceId, "candidate");
    const updated = store.recordComparison({
      insertionId: "insertion-1",
      expectedRevision: 0,
      actionId: "telegram-action-1",
      existingPlaceId: step.existingPlaceId,
      winner: "candidate",
      state: next,
      now: 4,
    });
    const repeated = store.recordComparison({
      insertionId: "insertion-1",
      expectedRevision: 0,
      actionId: "telegram-action-1",
      existingPlaceId: step.existingPlaceId,
      winner: "candidate",
      state: next,
      now: 5,
    });

    expect(updated.revision).toBe(1);
    expect(repeated).toEqual(updated);
    expect(store.listComparisons("insertion-1")).toHaveLength(1);
    store.close();
    store = openPlacesStore(dbPath);
    expect(store.getActiveInsertion("chat:actor")).toMatchObject({
      id: "insertion-1",
      revision: 1,
      state: next,
    });
  });

  it("rejects stale writers without changing state or comparison history", () => {
    const categoryId = store.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    const state = createPlaceInsertion([], "liked");
    store.createInsertion({
      id: "insertion-1",
      ownerKey: "owner",
      candidateId: "candidate",
      name: "Candidate",
      categoryId,
      sentiment: "liked",
      state,
      now: 1,
    });

    expect(() =>
      store.recordComparison({
        insertionId: "insertion-1",
        expectedRevision: 9,
        actionId: "stale",
        existingPlaceId: "missing",
        winner: "candidate",
        state,
        now: 2,
      }),
    ).toThrow(/stale insertion revision/i);
    expect(store.getActiveInsertion("owner")?.revision).toBe(0);
    expect(store.listComparisons("insertion-1")).toEqual([]);
  });

  it("publishes a completed insertion and session status in one transaction", () => {
    const categoryId = store.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    const state = createPlaceInsertion([], "liked");
    store.createInsertion({
      id: "insertion-1",
      ownerKey: "owner",
      candidateId: "candidate",
      name: "Candidate",
      categoryId,
      sentiment: "liked",
      state,
      now: 1,
    });

    const completed = store.completeInsertion({
      insertionId: "insertion-1",
      expectedRevision: 0,
      actionId: "complete-1",
      index: 0,
      now: 2,
    });
    const repeated = store.completeInsertion({
      insertionId: "insertion-1",
      expectedRevision: 0,
      actionId: "complete-1",
      index: 0,
      now: 3,
    });

    expect(completed.id).toBe("candidate");
    expect(repeated).toEqual(completed);
    expect(store.getActiveInsertion("owner")).toBeUndefined();
    expect(store.listPlaces(categoryId).map((place) => place.id)).toEqual(["candidate"]);
  });

  it("creates a recoverable SQLite backup and a bounded published-data export", async () => {
    const categoryId = store.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    store.insertPlace({ id: "a", categoryId, name: "A", sentiment: "liked", index: 0, now: 1 });
    const backupPath = join(root, "backups", "places.db");

    await store.backup(backupPath);
    const backup = openPlacesStore(backupPath);
    try {
      expect(backup.listPlaces(categoryId).map((place) => place.id)).toEqual(["a"]);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    } finally {
      backup.close();
    }
    expect(store.exportPublishedData()).toMatchObject({
      version: 1,
      categories: expect.arrayContaining([
        expect.objectContaining({ id: categoryId, places: [expect.objectContaining({ id: "a" })] }),
      ]),
    });
  });
});
