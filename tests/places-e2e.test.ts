import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createPlaceInsertion } from "../src/places-ranking.js";
import { PlacesService } from "../src/places-service.js";
import { openPlacesStore, type PlacesStore } from "../src/places-store.js";

describe("places end-to-end acceptance", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("resumes after restart, rejects a stale button, and completes exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "places-e2e-"));
    roots.push(root);
    const path = join(root, "places.db");
    let store: PlacesStore = openPlacesStore(path);
    let nextId = 0;
    const options = {
      ownerKey: "private",
      now: () => 1_000 + nextId,
      createId: () => `id-${nextId++}`,
    };
    let service = new PlacesService(store, options);
    const category = service.listCategories()[0];
    if (!category) throw new Error("missing category");
    service.start({ name: "Existing", categoryId: category.id, sentiment: "liked" });
    const comparison = service.start({ name: "Candidate", categoryId: category.id, sentiment: "liked" });
    if (comparison.kind !== "compare") throw new Error("expected comparison");

    store.close();
    store = openPlacesStore(path);
    service = new PlacesService(store, options);
    expect(service.resume()).toEqual(comparison);
    const completed = service.answer({
      insertionId: comparison.insertionId,
      revision: comparison.revision,
      existingPlaceId: comparison.existingPlace.id,
      winner: "candidate",
    });
    expect(completed).toMatchObject({ kind: "complete", rank: 1, total: 2 });
    expect(() =>
      service.answer({
        insertionId: comparison.insertionId,
        revision: comparison.revision,
        existingPlaceId: comparison.existingPlace.id,
        winner: "existing",
      }),
    ).toThrowError(expect.objectContaining({ code: "NO_ACTIVE_INSERTION" }));
    expect(service.listRanking(category.id).map((place) => place.name)).toEqual([
      "Candidate",
      "Existing",
    ]);
    store.close();
  });

  it("keeps sentiment bands ordered through add, move, re-rank, and delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "places-bands-"));
    roots.push(root);
    const store = openPlacesStore(join(root, "places.db"));
    let id = 0;
    const service = new PlacesService(store, {
      ownerKey: "private",
      createId: () => `id-${id++}`,
      now: () => id + 1,
    });
    const [restaurants, coffee] = service.listCategories();
    if (!restaurants || !coffee) throw new Error("missing categories");
    const liked = service.start({ name: "Liked", categoryId: restaurants.id, sentiment: "liked" });
    const alright = service.start({ name: "Alright", categoryId: restaurants.id, sentiment: "alright" });
    const disliked = service.start({ name: "Disliked", categoryId: restaurants.id, sentiment: "disliked" });
    if (liked.kind !== "complete" || alright.kind !== "complete" || disliked.kind !== "complete") {
      throw new Error("empty bands should complete");
    }
    expect(service.listRanking(restaurants.id).map((place) => place.sentiment)).toEqual([
      "liked",
      "alright",
      "disliked",
    ]);

    service.reposition(alright.place.id, { categoryId: coffee.id, sentiment: "liked" });
    service.deletePlace(disliked.place.id);
    expect(service.listRanking(restaurants.id).map((place) => place.name)).toEqual(["Liked"]);
    expect(service.listRanking(coffee.id)).toEqual([
      expect.objectContaining({ name: "Alright", sentiment: "liked", position: 0 }),
    ]);
    store.close();
  });

  it("migrates a version-2 database without losing rankings or active state", async () => {
    const root = await mkdtemp(join(tmpdir(), "places-v2-"));
    roots.push(root);
    const path = join(root, "places.db");
    const legacy = new DatabaseSync(path);
    const state = createPlaceInsertion([{ id: "existing", sentiment: "liked" }], "liked");
    legacy.exec(`
      CREATE TABLE category (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE place (id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES category(id), name TEXT NOT NULL, normalized_name TEXT NOT NULL, sentiment TEXT NOT NULL, notes TEXT, position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(category_id, normalized_name), UNIQUE(category_id, position)) STRICT;
      CREATE TABLE insertion_session (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, candidate_id TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES category(id), sentiment TEXT NOT NULL, notes TEXT, state_json TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, completion_action_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE UNIQUE INDEX one_active_insertion_per_owner ON insertion_session(owner_key) WHERE status = 'active';
      CREATE TABLE comparison (insertion_id TEXT NOT NULL REFERENCES insertion_session(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, action_id TEXT NOT NULL UNIQUE, existing_place_id TEXT NOT NULL, winner TEXT NOT NULL, created_at INTEGER NOT NULL, undone_at INTEGER, undo_action_id TEXT, PRIMARY KEY(insertion_id, sequence)) STRICT;
      CREATE UNIQUE INDEX unique_comparison_undo_action ON comparison(undo_action_id) WHERE undo_action_id IS NOT NULL;
      INSERT INTO category VALUES ('restaurants', 'Restaurants', 'restaurants', 0, 1, 1);
      INSERT INTO place VALUES ('existing', 'restaurants', 'Existing', 'existing', 'liked', NULL, 0, 1, 1);
      PRAGMA user_version = 2;
    `);
    legacy.prepare("INSERT INTO insertion_session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "active",
      "private",
      "candidate",
      "Candidate",
      "candidate",
      "restaurants",
      "liked",
      null,
      JSON.stringify(state),
      0,
      "active",
      null,
      2,
      2,
    );
    legacy.close();

    const migrated = openPlacesStore(path);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.listPlaces("restaurants").map((place) => place.name)).toEqual(["Existing"]);
    expect(migrated.getActiveInsertion("private")).toMatchObject({
      id: "active",
      sourcePlaceId: null,
      state,
    });
    migrated.close();
  });
});
