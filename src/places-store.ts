import { chmodSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";

import {
  answerPlaceComparison,
  applyPlaceInsertion,
  getPlaceInsertionStep,
  PLACE_SENTIMENTS,
  undoPlaceComparison,
  type PlaceComparisonWinner,
  type PlaceInsertionState,
  type RankedPlace,
  type Sentiment,
} from "./places-ranking.js";

const SCHEMA_VERSION = 2;

export interface PlaceCategory {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredPlace extends RankedPlace {
  categoryId: string;
  name: string;
  normalizedName: string;
  notes: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ActiveInsertion {
  id: string;
  ownerKey: string;
  candidateId: string;
  name: string;
  normalizedName: string;
  categoryId: string;
  sentiment: Sentiment;
  notes: string | null;
  state: PlaceInsertionState;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredComparison {
  sequence: number;
  actionId: string;
  existingPlaceId: string;
  winner: PlaceComparisonWinner;
  createdAt: number;
  undoneAt: number | null;
}

interface CreateInsertionInput {
  id: string;
  ownerKey: string;
  candidateId: string;
  name: string;
  categoryId: string;
  sentiment: Sentiment;
  notes?: string | null;
  state: PlaceInsertionState;
  now: number;
}

interface RecordComparisonInput {
  insertionId: string;
  expectedRevision: number;
  actionId: string;
  existingPlaceId: string;
  winner: PlaceComparisonWinner;
  state: PlaceInsertionState;
  now: number;
}

interface UndoComparisonInput {
  insertionId: string;
  expectedRevision: number;
  actionId: string;
  now: number;
}

interface InsertPlaceInput {
  id: string;
  categoryId: string;
  name: string;
  sentiment: Sentiment;
  notes?: string | null;
  index: number;
  now: number;
}

interface CompleteInsertionInput {
  insertionId: string;
  expectedRevision: number;
  actionId: string;
  index: number;
  now: number;
}

export interface PublishedPlacesExport {
  version: 1;
  categories: Array<PlaceCategory & { places: StoredPlace[] }>;
}

export interface PlacesStore {
  readonly schemaVersion: number;
  listCategories(): PlaceCategory[];
  createCategory(id: string, name: string, now: number): PlaceCategory;
  listPlaces(categoryId: string): StoredPlace[];
  insertPlace(input: InsertPlaceInput): StoredPlace;
  deletePlace(id: string): void;
  createInsertion(input: CreateInsertionInput): ActiveInsertion;
  getActiveInsertion(ownerKey: string): ActiveInsertion | undefined;
  recordComparison(input: RecordComparisonInput): ActiveInsertion;
  undoComparison(input: UndoComparisonInput): ActiveInsertion;
  listComparisons(insertionId: string): StoredComparison[];
  completeInsertion(input: CompleteInsertionInput): StoredPlace;
  cancelInsertion(insertionId: string, expectedRevision: number, now: number): void;
  exportPublishedData(): PublishedPlacesExport;
  backup(destinationPath: string): Promise<void>;
  close(): void;
}

interface CategoryRow {
  id: string;
  name: string;
  normalized_name: string;
  created_at: number;
  updated_at: number;
}

interface PlaceRow {
  id: string;
  category_id: string;
  name: string;
  normalized_name: string;
  sentiment: string;
  notes: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

interface InsertionRow {
  id: string;
  owner_key: string;
  candidate_id: string;
  name: string;
  normalized_name: string;
  category_id: string;
  sentiment: string;
  notes: string | null;
  state_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
  status: string;
  completion_action_id: string | null;
}

interface ComparisonRow {
  sequence: number;
  action_id: string;
  existing_place_id: string;
  winner: string;
  created_at: number;
  undone_at: number | null;
}

export function normalizePlaceName(name: string): string {
  return name.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function requireName(name: string, label: string): { name: string; normalized: string } {
  const trimmed = name.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (trimmed.length > 200) throw new Error(`${label} is too long`);
  return { name: trimmed, normalized: normalizePlaceName(trimmed) };
}

function isSentiment(value: string): value is Sentiment {
  return PLACE_SENTIMENTS.includes(value as Sentiment);
}

function categoryFromRow(row: CategoryRow): PlaceCategory {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function placeFromRow(row: PlaceRow): StoredPlace {
  if (!isSentiment(row.sentiment)) throw new Error("Stored place has invalid sentiment");
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    normalizedName: row.normalized_name,
    sentiment: row.sentiment,
    notes: row.notes,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertionFromRow(row: InsertionRow): ActiveInsertion {
  if (!isSentiment(row.sentiment)) throw new Error("Stored insertion has invalid sentiment");
  let state: PlaceInsertionState;
  try {
    state = JSON.parse(row.state_json) as PlaceInsertionState;
  } catch {
    throw new Error("Stored insertion state is invalid JSON");
  }
  return {
    id: row.id,
    ownerKey: row.owner_key,
    candidateId: row.candidate_id,
    name: row.name,
    normalizedName: row.normalized_name,
    categoryId: row.category_id,
    sentiment: row.sentiment,
    notes: row.notes,
    state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function migrate(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as unknown as {
    user_version: number;
  };
  if (row.user_version > SCHEMA_VERSION) {
    throw new Error(`Places database schema ${row.user_version} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (row.user_version === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE category (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          sort_order      INTEGER NOT NULL UNIQUE,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE place (
          id              TEXT PRIMARY KEY,
          category_id     TEXT NOT NULL REFERENCES category(id),
          name            TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          sentiment       TEXT NOT NULL CHECK (sentiment IN ('liked', 'alright', 'disliked')),
          notes           TEXT,
          position        INTEGER NOT NULL,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          UNIQUE (category_id, normalized_name),
          UNIQUE (category_id, position)
        ) STRICT;
        CREATE TABLE insertion_session (
          id                   TEXT PRIMARY KEY,
          owner_key            TEXT NOT NULL,
          candidate_id         TEXT NOT NULL,
          name                 TEXT NOT NULL,
          normalized_name      TEXT NOT NULL,
          category_id          TEXT NOT NULL REFERENCES category(id),
          sentiment            TEXT NOT NULL CHECK (sentiment IN ('liked', 'alright', 'disliked')),
          notes                TEXT,
          state_json           TEXT NOT NULL,
          revision             INTEGER NOT NULL,
          status               TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
          completion_action_id TEXT UNIQUE,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX one_active_insertion_per_owner
          ON insertion_session(owner_key) WHERE status = 'active';
        CREATE TABLE comparison (
          insertion_id     TEXT NOT NULL REFERENCES insertion_session(id) ON DELETE CASCADE,
          sequence         INTEGER NOT NULL,
          action_id        TEXT NOT NULL UNIQUE,
          existing_place_id TEXT NOT NULL,
          winner           TEXT NOT NULL CHECK (winner IN ('candidate', 'existing')),
          created_at       INTEGER NOT NULL,
          undone_at        INTEGER,
          undo_action_id   TEXT,
          PRIMARY KEY (insertion_id, sequence)
        ) STRICT;
        CREATE UNIQUE INDEX unique_comparison_undo_action
          ON comparison(undo_action_id) WHERE undo_action_id IS NOT NULL;
      `);
      const seed = db.prepare(
        "INSERT INTO category (id, name, normalized_name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
      );
      for (const [index, name] of ["Restaurants", "Coffee", "Bars"].entries()) {
        seed.run(`default-${name.toLowerCase()}`, name, normalizePlaceName(name), index);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (row.user_version === 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE comparison ADD COLUMN undone_at INTEGER;
        ALTER TABLE comparison ADD COLUMN undo_action_id TEXT;
        CREATE UNIQUE INDEX unique_comparison_undo_action
          ON comparison(undo_action_id) WHERE undo_action_id IS NOT NULL;
        PRAGMA user_version = 2;
        COMMIT;
      `);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return SCHEMA_VERSION;
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openPlacesStore(dbPath: string): PlacesStore {
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  chmodSync(dbPath, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  const schemaVersion = migrate(db);

  const listCategories = (): PlaceCategory[] =>
    (db.prepare("SELECT id, name, normalized_name, created_at, updated_at FROM category ORDER BY sort_order").all() as unknown as CategoryRow[]).map(categoryFromRow);
  const listPlaces = (categoryId: string): StoredPlace[] =>
    (db.prepare("SELECT * FROM place WHERE category_id = ? ORDER BY position").all(categoryId) as unknown as PlaceRow[]).map(placeFromRow);
  const getInsertionRow = (id: string): InsertionRow | undefined =>
    db.prepare("SELECT * FROM insertion_session WHERE id = ?").get(id) as unknown as InsertionRow | undefined;
  const getPlace = (id: string): StoredPlace | undefined => {
    const row = db.prepare("SELECT * FROM place WHERE id = ?").get(id) as unknown as PlaceRow | undefined;
    return row ? placeFromRow(row) : undefined;
  };

  const insertPlaceInternal = (input: InsertPlaceInput): StoredPlace => {
    const parsed = requireName(input.name, "Place name");
    const ranking = listPlaces(input.categoryId);
    if (!Number.isInteger(input.index) || input.index < 0 || input.index > ranking.length) {
      throw new Error("Place insertion index is outside the category ranking");
    }
    const order = PLACE_SENTIMENTS.indexOf(input.sentiment);
    if (order < 0) throw new Error("Invalid place sentiment");
    const before = ranking[input.index - 1];
    const after = ranking[input.index];
    if ((before && PLACE_SENTIMENTS.indexOf(before.sentiment) > order) || (after && PLACE_SENTIMENTS.indexOf(after.sentiment) < order)) {
      throw new Error("Place insertion would violate sentiment order");
    }

    db.prepare("UPDATE place SET position = -position - 1 WHERE category_id = ? AND position >= ?").run(input.categoryId, input.index);
    db.prepare("UPDATE place SET position = -position WHERE category_id = ? AND position < 0").run(input.categoryId);
    db.prepare(`INSERT INTO place
      (id, category_id, name, normalized_name, sentiment, notes, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.categoryId, parsed.name, parsed.normalized, input.sentiment, input.notes ?? null, input.index, input.now, input.now);
    const inserted = getPlace(input.id);
    if (!inserted) throw new Error("Inserted place could not be read back");
    return inserted;
  };

  const store: PlacesStore = {
    schemaVersion,
    listCategories,
    createCategory(id, name, now) {
      const parsed = requireName(name, "Category name");
      return transaction(db, () => {
        const next = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM category").get() as unknown as { value: number };
        db.prepare("INSERT INTO category (id, name, normalized_name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, parsed.name, parsed.normalized, next.value, now, now);
        const row = db.prepare("SELECT id, name, normalized_name, created_at, updated_at FROM category WHERE id = ?").get(id) as unknown as CategoryRow;
        return categoryFromRow(row);
      });
    },
    listPlaces,
    insertPlace(input) {
      return transaction(db, () => insertPlaceInternal(input));
    },
    deletePlace(id) {
      transaction(db, () => {
        const existing = getPlace(id);
        if (!existing) return;
        db.prepare("DELETE FROM place WHERE id = ?").run(id);
        db.prepare("UPDATE place SET position = -position - 1 WHERE category_id = ? AND position > ?").run(existing.categoryId, existing.position);
        db.prepare("UPDATE place SET position = -position - 2 WHERE category_id = ? AND position < 0").run(existing.categoryId);
      });
    },
    createInsertion(input) {
      const parsed = requireName(input.name, "Place name");
      getPlaceInsertionStep(listPlaces(input.categoryId), input.state);
      return transaction(db, () => {
        db.prepare(`INSERT INTO insertion_session
          (id, owner_key, candidate_id, name, normalized_name, category_id, sentiment, notes, state_json, revision, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`)
          .run(input.id, input.ownerKey, input.candidateId, parsed.name, parsed.normalized, input.categoryId, input.sentiment, input.notes ?? null, JSON.stringify(input.state), input.now, input.now);
        const row = getInsertionRow(input.id);
        if (!row) throw new Error("Created insertion could not be read back");
        return insertionFromRow(row);
      });
    },
    getActiveInsertion(ownerKey) {
      const row = db.prepare("SELECT * FROM insertion_session WHERE owner_key = ? AND status = 'active'").get(ownerKey) as unknown as InsertionRow | undefined;
      return row ? insertionFromRow(row) : undefined;
    },
    recordComparison(input) {
      return transaction(db, () => {
        const duplicate = db.prepare("SELECT insertion_id FROM comparison WHERE action_id = ?").get(input.actionId) as unknown as { insertion_id: string } | undefined;
        if (duplicate) {
          if (duplicate.insertion_id !== input.insertionId) throw new Error("Comparison action ID belongs to another insertion");
          const repeated = getInsertionRow(input.insertionId);
          if (!repeated) throw new Error("Insertion not found");
          return insertionFromRow(repeated);
        }
        const row = getInsertionRow(input.insertionId);
        if (!row || row.status !== "active") throw new Error("Active insertion not found");
        if (row.revision !== input.expectedRevision) throw new Error("Stale insertion revision");
        const ranking = listPlaces(row.category_id);
        const current = insertionFromRow(row);
        const expectedState = answerPlaceComparison(
          ranking,
          current.state,
          input.existingPlaceId,
          input.winner,
        );
        if (JSON.stringify(expectedState) !== JSON.stringify(input.state)) {
          throw new Error("Comparison state does not match the recorded answer");
        }
        db.prepare("INSERT INTO comparison (insertion_id, sequence, action_id, existing_place_id, winner, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(input.insertionId, row.revision, input.actionId, input.existingPlaceId, input.winner, input.now);
        db.prepare("UPDATE insertion_session SET state_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(input.state), input.now, input.insertionId);
        const updated = getInsertionRow(input.insertionId);
        if (!updated) throw new Error("Updated insertion could not be read back");
        return insertionFromRow(updated);
      });
    },
    undoComparison(input) {
      return transaction(db, () => {
        const duplicate = db.prepare("SELECT insertion_id FROM comparison WHERE undo_action_id = ?").get(input.actionId) as unknown as { insertion_id: string } | undefined;
        if (duplicate) {
          if (duplicate.insertion_id !== input.insertionId) throw new Error("Undo action ID belongs to another insertion");
          const repeated = getInsertionRow(input.insertionId);
          if (!repeated) throw new Error("Insertion not found");
          return insertionFromRow(repeated);
        }
        const row = getInsertionRow(input.insertionId);
        if (!row || row.status !== "active") throw new Error("Active insertion not found");
        if (row.revision !== input.expectedRevision) throw new Error("Stale insertion revision");
        const current = insertionFromRow(row);
        const previousState = undoPlaceComparison(current.state);
        const comparison = db.prepare("SELECT sequence FROM comparison WHERE insertion_id = ? AND undone_at IS NULL ORDER BY sequence DESC LIMIT 1").get(input.insertionId) as unknown as { sequence: number } | undefined;
        if (!comparison) throw new Error("There is no comparison to undo");
        db.prepare("UPDATE comparison SET undone_at = ?, undo_action_id = ? WHERE insertion_id = ? AND sequence = ?")
          .run(input.now, input.actionId, input.insertionId, comparison.sequence);
        db.prepare("UPDATE insertion_session SET state_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(previousState), input.now, input.insertionId);
        const updated = getInsertionRow(input.insertionId);
        if (!updated) throw new Error("Updated insertion could not be read back");
        return insertionFromRow(updated);
      });
    },
    listComparisons(insertionId) {
      const rows = db.prepare("SELECT sequence, action_id, existing_place_id, winner, created_at, undone_at FROM comparison WHERE insertion_id = ? ORDER BY sequence").all(insertionId) as unknown as ComparisonRow[];
      return rows.map((row) => {
        if (row.winner !== "candidate" && row.winner !== "existing") throw new Error("Stored comparison has invalid winner");
        return { sequence: row.sequence, actionId: row.action_id, existingPlaceId: row.existing_place_id, winner: row.winner, createdAt: row.created_at, undoneAt: row.undone_at };
      });
    },
    completeInsertion(input) {
      return transaction(db, () => {
        const row = getInsertionRow(input.insertionId);
        if (!row) throw new Error("Insertion not found");
        if (row.status === "completed" && row.completion_action_id === input.actionId) {
          const repeated = getPlace(row.candidate_id);
          if (!repeated) throw new Error("Completed insertion is missing its place");
          return repeated;
        }
        if (row.status !== "active") throw new Error("Active insertion not found");
        if (row.revision !== input.expectedRevision) throw new Error("Stale insertion revision");
        const insertion = insertionFromRow(row);
        const ranking = listPlaces(row.category_id);
        const result = applyPlaceInsertion(ranking, insertion.state, { id: row.candidate_id, sentiment: insertion.sentiment });
        const actualIndex = result.findIndex((place) => place.id === row.candidate_id);
        if (actualIndex !== input.index) throw new Error("Completion index does not match insertion state");
        const place = insertPlaceInternal({ id: row.candidate_id, categoryId: row.category_id, name: row.name, sentiment: insertion.sentiment, notes: row.notes, index: actualIndex, now: input.now });
        db.prepare("UPDATE insertion_session SET status = 'completed', completion_action_id = ?, updated_at = ? WHERE id = ?")
          .run(input.actionId, input.now, input.insertionId);
        return place;
      });
    },
    cancelInsertion(insertionId, expectedRevision, now) {
      transaction(db, () => {
        const result = db.prepare("UPDATE insertion_session SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active' AND revision = ?")
          .run(now, insertionId, expectedRevision);
        if (result.changes !== 1) throw new Error("Active insertion not found or revision is stale");
      });
    },
    exportPublishedData() {
      return { version: 1, categories: listCategories().map((category) => ({ ...category, places: listPlaces(category.id) })) };
    },
    async backup(destinationPath) {
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      await backupDatabase(db, destinationPath);
      await chmod(destinationPath, 0o600);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
  return store;
}
