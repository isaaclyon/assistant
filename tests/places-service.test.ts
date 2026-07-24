import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PlacesService, PlacesServiceError } from "../src/places-service.js";
import { openPlacesStore, type PlacesStore } from "../src/places-store.js";

describe("PlacesService", () => {
  let root: string;
  let store: PlacesStore;
  let service: PlacesService;
  let sequence: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "places-service-"));
    store = openPlacesStore(join(root, "places.db"));
    sequence = 0;
    service = new PlacesService(store, {
      ownerKey: "private",
      now: () => 100 + sequence,
      createId: () => `generated-${sequence++}`,
    });
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("publishes the first place immediately and reports its final rank", () => {
    const categoryId = service.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");

    expect(service.start({ name: "First", categoryId, sentiment: "liked" })).toMatchObject({
      kind: "complete",
      place: { name: "First", position: 0 },
      rank: 1,
      total: 1,
    });
  });

  it("returns durable comparisons and completes after valid answers", () => {
    const categoryId = service.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    service.start({ name: "Existing", categoryId, sentiment: "liked" });

    const started = service.start({ name: "Candidate", categoryId, sentiment: "liked" });
    expect(started.kind).toBe("compare");
    if (started.kind !== "compare") throw new Error("expected comparison");
    expect(service.resume()).toEqual(started);

    const result = service.answer({
      insertionId: started.insertionId,
      revision: started.revision,
      existingPlaceId: started.existingPlace.id,
      winner: "candidate",
    });
    expect(result).toMatchObject({ kind: "complete", rank: 1, total: 2 });
    expect(service.listRanking(categoryId).map((place) => place.name)).toEqual([
      "Candidate",
      "Existing",
    ]);
  });

  it("returns stable actionable errors for duplicates, stale actions, and missing sessions", () => {
    const categoryId = service.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    service.start({ name: "Same Place", categoryId, sentiment: "liked" });
    expect(() => service.start({ name: " same   place ", categoryId, sentiment: "liked" })).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_PLACE" }),
    );

    expect(() => service.resume()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_INSERTION" }),
    );
    expect(() =>
      service.answer({ insertionId: "missing", revision: 0, existingPlaceId: "x", winner: "candidate" }),
    ).toThrowError(PlacesServiceError);
  });

  it("cancels an unfinished insertion without changing the published ranking", () => {
    const categoryId = service.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    service.start({ name: "Existing", categoryId, sentiment: "liked" });
    const started = service.start({ name: "Candidate", categoryId, sentiment: "liked" });
    if (started.kind !== "compare") throw new Error("expected comparison");

    service.cancel(started.insertionId, started.revision);

    expect(service.listRanking(categoryId).map((place) => place.name)).toEqual(["Existing"]);
    expect(() => service.resume()).toThrowError(
      expect.objectContaining({ code: "NO_ACTIVE_INSERTION" }),
    );
  });

  it("returns to the exact previous comparison", () => {
    const categoryId = service.listCategories()[0]?.id;
    if (!categoryId) throw new Error("missing category");
    for (const [index, name] of ["A", "B", "C", "D"].entries()) {
      store.insertPlace({
        id: `place-${index}`,
        categoryId,
        name,
        sentiment: "liked",
        index,
        now: index,
      });
    }
    const first = service.start({ name: "Candidate", categoryId, sentiment: "liked" });
    if (first.kind !== "compare") throw new Error("expected comparison");
    const second = service.answer({
      insertionId: first.insertionId,
      revision: first.revision,
      existingPlaceId: first.existingPlace.id,
      winner: "candidate",
    });
    if (second.kind !== "compare") throw new Error("expected second comparison");

    const restored = service.back(second.insertionId, second.revision);

    expect(restored).toMatchObject({
      kind: "compare",
      insertionId: first.insertionId,
      existingPlace: { id: first.existingPlace.id },
    });
  });

  it("creates normalized unique categories", () => {
    expect(service.createCategory(" Bakeries ").name).toBe("Bakeries");
    expect(() => service.createCategory("bakeries")).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_CATEGORY" }),
    );
  });
});
