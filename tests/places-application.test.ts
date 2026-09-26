import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openPlacesStore } from "../src/places-store.js";
import { PlacesService } from "../src/places-service.js";
import { PlacesApplication } from "../src/places-application.js";

it("runs headless commands with bounded pages and single-use operation confirmations", () => {
  const dir = mkdtempSync(join(tmpdir(), "places-app-"));
  const store = openPlacesStore(join(dir, "places.db"));
  try {
    let now = 1000;
    const app = new PlacesApplication(new PlacesService(store, { ownerKey: "test" }), () => now);
    const category = app.execute({ action: "create_category", name: "Test" });
    if (!category.category) throw new Error("missing category");
    const categoryId = category.category.id;
    const result = app.execute({ action: "start", category_id: categoryId, name: "Cafe", sentiment: "liked" });
    if (!("kind" in result) || result.kind !== "complete") throw new Error("missing completion");
    expect(app.execute({ action: "ranking", category_id: category.category.id, limit: 1 })).toMatchObject({ total: 1, hasNext: false });
    const confirmation = app.execute({ action: "request_confirmation", confirmation_operation: "delete_place", place_id: result.place.id });
    if (!("kind" in confirmation) || confirmation.kind !== "confirmation") throw new Error("missing confirmation");
    expect(() => app.execute({ action: "delete_category", category_id: categoryId, confirmation_token: confirmation.token })).toThrow();
    expect(() => app.execute({ action: "delete_place", place_id: result.place.id, confirmation_token: confirmation.token })).toThrow();
    expect(app.execute({ action: "place", place_id: result.place.id })).toMatchObject({ place: { name: "Cafe" } });
    expect(() => app.execute({ action: "ranking", category_id: categoryId, limit: 0 })).toThrow();
    const deletion = app.execute({ action: "request_confirmation", confirmation_operation: "delete_place", place_id: result.place.id });
    if (deletion.kind !== "confirmation") throw new Error("missing confirmation");
    app.execute({ action: "edit_place", place_id: result.place.id, notes: "Changed since confirmation" });
    expect(() => app.execute({ action: "delete_place", place_id: result.place.id, confirmation_token: deletion.token })).toThrow(/stale|changed/i);
    const categoryDeletion = app.execute({ action: "request_confirmation", confirmation_operation: "delete_category", category_id: categoryId });
    if (categoryDeletion.kind !== "confirmation") throw new Error("missing confirmation");
    app.execute({ action: "rename_category", category_id: categoryId, name: "Renamed" });
    expect(() => app.execute({ action: "delete_category", category_id: categoryId, confirmation_token: categoryDeletion.token })).toThrow(/stale|changed/i);
    expect(() => app.execute({ action: "edit_place", place_id: result.place.id, notes: "x".repeat(4001) })).toThrow();
    const expired = app.execute({ action: "request_confirmation", confirmation_operation: "delete_place", place_id: result.place.id });
    if (expired.kind !== "confirmation") throw new Error("missing confirmation");
    now += 10 * 60_000;
    expect(() => app.execute({ action: "delete_place", place_id: result.place.id, confirmation_token: expired.token })).toThrow(/expired/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
