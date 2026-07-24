import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PlacesService } from "../src/places-service.js";
import { openPlacesStore, type PlacesStore } from "../src/places-store.js";

describe("places management", () => {
  let root: string;
  let store: PlacesStore;
  let service: PlacesService;
  let id: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "places-management-"));
    store = openPlacesStore(join(root, "places.db"));
    id = 0;
    service = new PlacesService(store, {
      ownerKey: "private",
      now: () => 1_000 + id,
      createId: () => `id-${id++}`,
    });
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("lists category counts and supports place details, edits, and confirmed deletion", () => {
    const category = service.listCategories()[0];
    if (!category) throw new Error("missing category");
    const added = service.start({ name: "Old Name", categoryId: category.id, sentiment: "liked" });
    if (added.kind !== "complete") throw new Error("expected completion");

    expect(service.listCategorySummaries()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: category.id, placeCount: 1 })]),
    );
    expect(service.getPlace(added.place.id)).toMatchObject({ name: "Old Name" });
    expect(service.editPlace(added.place.id, { name: "New Name", notes: "Great patio" })).toMatchObject({
      name: "New Name",
      notes: "Great patio",
    });
    service.deletePlace(added.place.id);
    expect(service.listRanking(category.id)).toEqual([]);
  });

  it("keeps a move provisional and publishes it atomically on completion", () => {
    const [restaurants, coffee] = service.listCategories();
    if (!restaurants || !coffee) throw new Error("missing categories");
    const added = service.start({ name: "Hybrid", categoryId: restaurants.id, sentiment: "liked" });
    if (added.kind !== "complete") throw new Error("expected completion");

    const moved = service.reposition(added.place.id, { categoryId: coffee.id, sentiment: "alright" });

    expect(moved).toMatchObject({ kind: "complete", place: { categoryId: coffee.id, sentiment: "alright" } });
    expect(service.listRanking(restaurants.id)).toEqual([]);
    expect(service.listRanking(coffee.id).map((place) => place.name)).toEqual(["Hybrid"]);
  });

  it("cancels a provisional re-rank without changing the original placement", () => {
    const category = service.listCategories()[0];
    if (!category) throw new Error("missing category");
    const first = service.start({ name: "First", categoryId: category.id, sentiment: "liked" });
    const second = service.start({ name: "Second", categoryId: category.id, sentiment: "liked" });
    if (first.kind !== "complete" || second.kind !== "compare") throw new Error("unexpected flow");
    const completedSecond = service.answer({
      insertionId: second.insertionId,
      revision: second.revision,
      existingPlaceId: second.existingPlace.id,
      winner: "existing",
    });
    if (completedSecond.kind !== "complete") throw new Error("expected completion");

    const rerank = service.reposition(first.place.id, { sentiment: "liked" });
    if (rerank.kind === "compare") service.cancel(rerank.insertionId, rerank.revision);

    expect(service.getPlace(first.place.id)).toMatchObject({ sentiment: "liked", position: 0 });
  });

  it("undoes the latest addition only while its category has not changed", () => {
    const category = service.listCategories()[0];
    if (!category) throw new Error("missing category");
    const added = service.start({ name: "Undo Me", categoryId: category.id, sentiment: "liked" });
    if (added.kind !== "complete") throw new Error("expected completion");
    if (!added.undoInsertionId) throw new Error("missing undo insertion ID");

    service.undoAddition(added.undoInsertionId);

    expect(service.listRanking(category.id)).toEqual([]);
  });

  it("renames and deletes only empty categories", () => {
    const category = service.createCategory("Bakeries");
    expect(service.renameCategory(category.id, "Pastry Shops").name).toBe("Pastry Shops");
    service.deleteCategory(category.id);
    expect(service.listCategories().some((entry) => entry.id === category.id)).toBe(false);

    const occupied = service.createCategory("Ice Cream");
    service.start({ name: "Sweet Cow", categoryId: occupied.id, sentiment: "liked" });
    expect(() => service.deleteCategory(occupied.id)).toThrow(/empty/i);
  });
});
