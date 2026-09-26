import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface GooglePlacesGatewayRequest {
  operation: "search" | "details";
  profile: string;
  cacheArguments: Readonly<Record<string, string>>;
  sku: string;
  monthlyLimit: number;
  ttlMs: number;
  now: number;
  cache?: boolean;
}

export type GooglePlacesGatewayResult<T> =
  | { status: "ok"; cached: boolean; value: T }
  | { status: "blocked"; sku: string; month: string };

export interface GooglePlacesGateway {
  request<T>(request: GooglePlacesGatewayRequest, fetch: () => Promise<T>): Promise<GooglePlacesGatewayResult<T>>;
  close(): void;
}

interface CacheRow {
  response_json: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cacheKey(request: GooglePlacesGatewayRequest): string {
  return createHash("sha256")
    .update(canonical({
      operation: request.operation,
      profile: request.profile,
      arguments: request.cacheArguments,
    }))
    .digest("hex");
}

function billingMonth(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Google Places request time is invalid");
  return new Date(now).toISOString().slice(0, 7);
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

export function openGooglePlacesGateway(databasePath: string): GooglePlacesGateway {
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS places_cache (
      cache_key     TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      expires_at    INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS places_usage (
      billing_month TEXT NOT NULL,
      sku            TEXT NOT NULL,
      attempts       INTEGER NOT NULL CHECK (attempts >= 0),
      PRIMARY KEY (billing_month, sku)
    ) STRICT;
  `);

  const cached = db.prepare(
    "SELECT response_json FROM places_cache WHERE cache_key = ? AND expires_at > ?",
  );
  const removeCache = db.prepare("DELETE FROM places_cache WHERE cache_key = ?");
  const usage = db.prepare(
    "SELECT attempts FROM places_usage WHERE billing_month = ? AND sku = ?",
  );
  const increment = db.prepare(`
    INSERT INTO places_usage (billing_month, sku, attempts) VALUES (?, ?, 1)
    ON CONFLICT (billing_month, sku) DO UPDATE SET attempts = attempts + 1
  `);
  const save = db.prepare(`
    INSERT INTO places_cache (cache_key, response_json, expires_at) VALUES (?, ?, ?)
    ON CONFLICT (cache_key) DO UPDATE SET
      response_json = excluded.response_json,
      expires_at = excluded.expires_at
  `);

  return {
    async request<T>(request: GooglePlacesGatewayRequest, fetch: () => Promise<T>) {
      if (
        !Number.isSafeInteger(request.monthlyLimit) || request.monthlyLimit < 0 ||
        !Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1 ||
        !request.profile || !request.sku
      ) {
        throw new Error("Google Places gateway request is invalid");
      }
      const key = cacheKey(request);
      const month = billingMonth(request.now);
      const reservation = transaction(db, () => {
        const row = request.cache === false
          ? undefined
          : cached.get(key, request.now) as unknown as CacheRow | undefined;
        if (row) {
          try {
            return { status: "cached" as const, value: JSON.parse(row.response_json) as T };
          } catch {
            removeCache.run(key);
          }
        }
        const current = usage.get(month, request.sku) as unknown as { attempts: number } | undefined;
        if ((current?.attempts ?? 0) >= request.monthlyLimit) {
          return { status: "blocked" as const };
        }
        increment.run(month, request.sku);
        return { status: "reserved" as const };
      });
      if (reservation.status === "cached") {
        return { status: "ok", cached: true, value: reservation.value };
      }
      if (reservation.status === "blocked") {
        return { status: "blocked", sku: request.sku, month };
      }
      const value = await fetch();
      if (request.cache !== false) {
        save.run(key, JSON.stringify(value), request.now + request.ttlMs);
      }
      return { status: "ok", cached: false, value };
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
