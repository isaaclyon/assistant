import { appendFile, open } from "node:fs/promises";
import { join } from "node:path";

import { MEMORY_RECALL_LOG_FILE } from "./memory-recall.js";

/**
 * ADR-0043: usage-based ranking. Notes earn points when recall injects them,
 * when the agent reads them, and when they are edited. Points halve every 90
 * days. After a 30-day grace period, a fading note with few points drops up to
 * three places in search and recall results. Durable notes never move.
 */
export type MemoryDecay = "durable" | "fading";
export const MEMORY_USAGE_LOG_FILE = "memory-usage.jsonl";
export const DEFAULT_MEMORY_DECAY: Readonly<Record<string, MemoryDecay>> = Object.freeze({
  person: "durable",
  preference: "durable",
  recipe: "durable",
  reference: "durable",
  list: "fading",
  event: "fading",
  purchase: "fading",
});
const DAY_MS = 24 * 60 * 60 * 1000;
export const USAGE_POINTS = Object.freeze({ injected: 1, read: 3, edited: 3 });
export const USAGE_HALF_LIFE_MS = 90 * DAY_MS;
export const FADING_GRACE_MS = 30 * DAY_MS;
/** Points at which a fading note keeps its full rank: one fresh read or edit. */
export const FULL_USAGE_POINTS = 3;
export const MAX_DECAY_DROP = 3;

export interface UsageEvent { at: number; points: number }
export interface RankableNote { id: string; type: string; created: string; updated: string }
export interface MemoryRanking { drop(note: RankableNote): number }

export function decayDrop(
  note: RankableNote,
  override: MemoryDecay | undefined,
  events: readonly UsageEvent[],
  now: number,
): number {
  // Unknown types stay put: never fade a note we cannot classify.
  if ((override ?? DEFAULT_MEMORY_DECAY[note.type] ?? "durable") === "durable") return 0;
  const created = Date.parse(note.created);
  if (!Number.isFinite(created) || now - created < FADING_GRACE_MS) return 0;
  const weight = (at: number) => 0.5 ** (Math.max(0, now - at) / USAGE_HALF_LIFE_MS);
  const updated = Date.parse(note.updated);
  let points = USAGE_POINTS.edited * weight(Number.isFinite(updated) ? updated : created);
  for (const event of events) points += event.points * weight(event.at);
  return Math.round(MAX_DECAY_DROP * (1 - Math.min(1, points / FULL_USAGE_POINTS)));
}

/**
 * Moves each result down by its drop. On a tie, the note that did not drop
 * keeps the place, so a drop of three lands exactly three places lower.
 */
export function rankWithDrops<T extends RankableNote>(results: readonly T[], ranking: MemoryRanking): T[] {
  return results
    .map((result, index) => ({ result, index, drop: ranking.drop(result) }))
    .sort((a, b) => a.index + a.drop - (b.index + b.drop) || a.drop - b.drop || a.index - b.index)
    .map(({ result }) => result);
}

export function createMemoryRanking(options: {
  usage: Pick<MemoryUsageTally, "events">;
  overrides: ReadonlyMap<string, MemoryDecay>;
  now: number;
}): MemoryRanking {
  return { drop: (note) => decayDrop(note, options.overrides.get(note.id), options.usage.events(note.id), options.now) };
}

/** Records the time and note ID only; never note text. */
export async function appendMemoryRead(stateDir: string, id: string, at: Date): Promise<void> {
  await appendFile(join(stateDir, MEMORY_USAGE_LOG_FILE),
    `${JSON.stringify({ at: at.toISOString(), event: "read", id })}\n`, { mode: 0o600 });
}

interface LogState { offset: number; inode: number; pending: Buffer; events: Map<string, UsageEvent[]> }

export interface MemoryUsageTally {
  /** Reads lines appended since the last call. Throws when a log cannot be read. */
  refresh(): Promise<void>;
  events(id: string): readonly UsageEvent[];
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function recallEvents(record: Record<string, unknown>): Array<[string, UsageEvent]> {
  const at = parseTime(record.at);
  if (at === undefined || !Array.isArray(record.candidates)) return [];
  return record.candidates.flatMap((candidate: unknown) => {
    const value = candidate as Record<string, unknown> | null;
    return value && value.result === "injected" && typeof value.id === "string"
      ? [[value.id, { at, points: USAGE_POINTS.injected }] as [string, UsageEvent]] : [];
  });
}

function readEvents(record: Record<string, unknown>): Array<[string, UsageEvent]> {
  const at = parseTime(record.at);
  return at !== undefined && record.event === "read" && typeof record.id === "string"
    ? [[record.id, { at, points: USAGE_POINTS.read }]] : [];
}

/**
 * Derives usage from append-only logs so the disposable search index holds
 * none of it. Only lines appended since the previous refresh are parsed; a
 * replaced or truncated log is reread from the start.
 */
export function createMemoryUsageTally(stateDir: string): MemoryUsageTally {
  const sources = [
    { path: join(stateDir, MEMORY_RECALL_LOG_FILE), parse: recallEvents },
    { path: join(stateDir, MEMORY_USAGE_LOG_FILE), parse: readEvents },
  ].map((source) => ({ ...source, state: { offset: 0, inode: -1, pending: Buffer.alloc(0), events: new Map() } as LogState }));
  let queue: Promise<void> = Promise.resolve();

  async function refreshSource(source: (typeof sources)[number]): Promise<void> {
    let handle;
    try {
      handle = await open(source.path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      source.state = { offset: 0, inode: -1, pending: Buffer.alloc(0), events: new Map() };
      return;
    }
    try {
      const { size, ino } = await handle.stat();
      if (ino !== source.state.inode || size < source.state.offset) {
        source.state = { offset: 0, inode: ino, pending: Buffer.alloc(0), events: new Map() };
      }
      if (size === source.state.offset) return;
      const chunk = Buffer.alloc(size - source.state.offset);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, source.state.offset);
      source.state.offset += bytesRead;
      const data = Buffer.concat([source.state.pending, chunk.subarray(0, bytesRead)]);
      const end = data.lastIndexOf(0x0a);
      // Keep a partially written last line for the next refresh.
      source.state.pending = Buffer.from(data.subarray(end + 1));
      if (end < 0) return;
      for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        if (!record || typeof record !== "object" || Array.isArray(record)) continue;
        for (const [id, event] of source.parse(record as Record<string, unknown>)) {
          const list = source.state.events.get(id);
          if (list) list.push(event);
          else source.state.events.set(id, [event]);
        }
      }
    } finally {
      await handle.close();
    }
  }

  return {
    refresh() {
      const run = queue.then(async () => {
        for (const source of sources) await refreshSource(source);
      });
      queue = run.catch(() => undefined);
      return run;
    },
    events(id) {
      return sources.flatMap((source) => source.state.events.get(id) ?? []);
    },
  };
}
