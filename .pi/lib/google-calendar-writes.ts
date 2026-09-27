import { createHash, randomUUID } from "node:crypto";
import type { GoogleRuntime } from "./google-transport.ts";
import { GoogleCommandError } from "./google-operations.ts";

export interface CalendarWriteConfig { account: string; personal: string; thingsToDo: string }
type Run = (runtime: GoogleRuntime, args: string[], signal?: AbortSignal) => Promise<unknown>;
type Json = Record<string, unknown>;
interface Target { runtime: GoogleRuntime; account: string; calendarId: string; calendar: string }
interface Pending { target: Target; event: Json; expires: number; chatId?: number }
const TTL = 10 * 60_000;
export const CALENDAR_WRITE_OPERATIONS = new Set(["calendar_event", "calendar_create", "calendar_update", "calendar_request_delete"]);

export class CalendarWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function invalid(): never { throw new CalendarWriteError("CALENDAR_INPUT_INVALID", "The Calendar request is invalid"); }
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Json;
}
function keys(value: Json, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0")) return invalid();
  return value;
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function throwDefiniteRejection(error: unknown) {
  if (error instanceof CalendarWriteError && ["CALENDAR_AUTH_REQUIRED", "CALENDAR_WRITE_FORBIDDEN", "CALENDAR_REQUEST_REJECTED"].includes(error.code)) throw error;
}

export function parseCalendarWriteConfig(value: string | undefined, instance: string | undefined): CalendarWriteConfig | undefined {
  if (!value || !instance) return undefined;
  try {
    const config = object(JSON.parse(value));
    keys(config, ["instance", "account", "personal", "thingsToDo"]);
    if (config.instance !== instance) return undefined;
    const account = string(config.account, 254);
    const personal = string(config.personal, 1_024);
    const thingsToDo = string(config.thingsToDo, 1_024);
    if (!/^[^\s@]+@[^\s@]+$/.test(account) || personal === thingsToDo ||
      [personal, thingsToDo].some(id => id === "primary" || /[\r\n]/.test(id))) return undefined;
    return { account, personal, thingsToDo };
  } catch { return undefined; }
}

function date(value: unknown): string {
  const selected = string(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || !Number.isFinite(Date.parse(selected)) ||
    new Date(selected).toISOString().slice(0, 10) !== selected) invalid();
  return selected;
}
function eventTime(value: unknown): Json {
  const input = object(value);
  if (input.date !== undefined) { keys(input, ["date"]); return { date: date(input.date) }; }
  keys(input, ["dateTime", "timeZone"]);
  const timestamp = string(input.dateTime, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) invalid();
  date(timestamp.slice(0, 10));
  const timeZone = string(input.timeZone, 64);
  // Validate the actual local clock as well as the zone name: reject DST gaps
  // and offsets that disagree with the explicitly selected IANA zone.
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
    const part = (name: string) => parts.find(p => p.type === name)?.value;
    if (`${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}` !== timestamp.slice(0, 19)) invalid();
  } catch { invalid(); }
  return { dateTime: timestamp, timeZone };
}
function validateInterval(start: Json, end: Json) {
  if (Boolean(start.date) !== Boolean(end.date) || Date.parse(String(end.date ?? end.dateTime)) <= Date.parse(String(start.date ?? start.dateTime))) invalid();
}
function fields(value: unknown, create: boolean): Json {
  const input = object(value);
  keys(input, ["summary", "description", "location", "start", "end"]);
  if (!Object.keys(input).length) invalid();
  const output: Json = {};
  for (const [key, max] of [["summary", 500], ["description", 4_000], ["location", 500]] as const) {
    if (input[key] !== undefined || (create && key === "summary")) output[key] = string(input[key], max, key !== "summary");
  }
  for (const key of ["start", "end"] as const) if (input[key] !== undefined || create) output[key] = eventTime(input[key]);
  if (output.start && output.end) validateInterval(object(output.start), object(output.end));
  return output;
}
function eventId(value: unknown): string {
  const id = string(value, 1_024);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) invalid();
  return id;
}
function editable(event: Json) {
  if (event.status === "cancelled" || (event.eventType && event.eventType !== "default") ||
    event.recurringEventId || event.originalStartTime || event.recurrence || event.attendeesOmitted ||
    (event.attendees !== undefined && (!Array.isArray(event.attendees) || event.attendees.length > 0)) ||
    (event.organizer && object(event.organizer).self !== true)) {
    throw new CalendarWriteError("CALENDAR_EVENT_EXCLUDED", "Only individual events without guests, invitations, or recurrence can be changed");
  }
}
function version(event: Json, expected: unknown) {
  if (string(expected, 200) !== event.etag) throw new CalendarWriteError("CALENDAR_EVENT_CHANGED", "The event changed. Read it again before requesting a change");
}
function normalized(event: Json, target: Target): Json {
  const result: Json = { id: event.id, etag: event.etag, calendar: target.calendar, calendarId: target.calendarId, account: target.account, untrusted: true };
  for (const [key, max] of [["summary", 500], ["description", 4_000], ["location", 500], ["status", 32]] as const) {
    if (typeof event[key] === "string") result[key] = event[key].slice(0, max);
  }
  for (const key of ["start", "end"] as const) {
    const time = object(event[key]);
    result[key] = Object.fromEntries(["date", "dateTime", "timeZone"].flatMap(name => typeof time[name] === "string" ? [[name, time[name].slice(0, 64)]] : []));
  }
  try { editable(event); result.editable = true; } catch { result.editable = false; }
  return result;
}
function matches(event: Json, patch: Json): boolean {
  return Object.entries(patch).every(([key, value]) => {
    if (key === "start" || key === "end") {
      const expected = object(value); const actual = object(event[key]);
      return expected.date ? expected.date === actual.date : Date.parse(String(expected.dateTime)) === Date.parse(String(actual.dateTime)) && expected.timeZone === actual.timeZone;
    }
    return (event[key] ?? "") === value;
  });
}

export class CalendarWrites {
  private pending = new Map<string, Pending>();
  // ponytail: one write at a time per instance; per-calendar locks if needed.
  private busy = false;
  private generation = 0;
  constructor(private readonly run: Run) {}
  clear() { this.pending.clear(); this.generation += 1; }
  discard(token: string) { this.pending.delete(token); }
  bind(token: string, chatId: number) {
    const item = this.pending.get(token);
    if (!item || item.chatId !== undefined) this.expired();
    item.chatId = chatId;
  }
  private expired(): never { throw new CalendarWriteError("CALENDAR_CONFIRMATION_EXPIRED", "This confirmation expired. Request a fresh deletion preview"); }
  private consume(token: string, chatId: number): Pending {
    const item = this.pending.get(token);
    if (!item || item.chatId !== chatId || item.expires <= Date.now()) this.expired();
    this.pending.delete(token);
    return item;
  }
  cancel(token: string, chatId: number) { this.consume(token, chatId); }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new CalendarWriteError("CALENDAR_BUSY", "Another Calendar change is in progress. Retry shortly");
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  private target(runtime: GoogleRuntime, input: Json): Target {
    const config = runtime.calendarWrites;
    if (!config) throw new CalendarWriteError("CALENDAR_WRITES_NOT_CONFIGURED", "Calendar writes need an instance-bound account and calendar allowlist. Configure Personal and Things to Do and authorize Calendar access");
    if (input.account !== undefined && input.account !== config.account) throw new CalendarWriteError("CALENDAR_WRITE_FORBIDDEN", "Calendar writes are enabled only for the configured personal account");
    const calendar = input.calendar ?? "personal";
    if (calendar !== "personal" && calendar !== "things_to_do") invalid();
    return { runtime, account: config.account, calendar, calendarId: calendar === "personal" ? config.personal : config.thingsToDo };
  }
  private async api(target: Target, method: "calendarList.get" | "events.get" | "events.insert" | "events.patch" | "events.delete", id?: string, body?: Json, signal?: AbortSignal): Promise<Json> {
    const write = method === "events.insert" || method === "events.patch" || method === "events.delete";
    // All API names, methods, scopes and query fields are owned here. Raw API
    // output stays internal; the public result is bounded and marked untrusted.
    let result: unknown;
    try { result = await this.run(target.runtime, ["--no-input", "--gmail-no-send", "--json", "--account", target.account,
      ...(write ? ["--force"] : ["--readonly"]), "api", "call", "calendar", "v3", `calendar.${method}`,
      `--scope=https://www.googleapis.com/auth/calendar`,
      `--params=${JSON.stringify({ calendarId: target.calendarId, ...(id ? { eventId: id } : {}), ...(write ? { sendUpdates: "none" } : {}) })}`,
      ...(write ? ["--allow-write"] : []), ...(body ? [`--body=${JSON.stringify(body)}`] : []),
    ], signal); } catch (error) {
      if (error instanceof GoogleCommandError) {
        if (error.code === "AUTH_REQUIRED") throw new CalendarWriteError("CALENDAR_AUTH_REQUIRED", "Google rejected the request because Calendar authorization is missing or insufficient. Reauthorize this account with Calendar write access before trying again");
        if (error.code === "FORBIDDEN") throw new CalendarWriteError("CALENDAR_WRITE_FORBIDDEN", "Google denied Calendar access. Check this account's Calendar grant and editor/owner permission");
        if (error.code === "INVALID_REQUEST") throw new CalendarWriteError("CALENDAR_REQUEST_REJECTED", "Google rejected the Calendar request. Review the requested event fields before retrying");
      }
      throw error;
    }
    return object(result);
  }
  private async permission(target: Target, signal?: AbortSignal) {
    const calendar = await this.api(target, "calendarList.get", undefined, undefined, signal);
    if (calendar.id !== target.calendarId || !["owner", "writer"].includes(String(calendar.accessRole))) {
      throw new CalendarWriteError("CALENDAR_WRITE_FORBIDDEN", "The configured account needs editor or owner access to this calendar");
    }
  }
  private async read(target: Target, id: string, signal?: AbortSignal): Promise<Json> {
    const event = await this.api(target, "events.get", id, undefined, signal);
    if (event.id !== id) throw new CalendarWriteError("CALENDAR_UNAVAILABLE", "Calendar returned an unexpected event");
    return event;
  }
  private current(generation: number, signal?: AbortSignal) {
    if (generation !== this.generation || signal?.aborted) throw new CalendarWriteError("CALENDAR_CANCELLED", "Calendar change cancelled before submission");
  }
  private unresolved(): never {
    throw new CalendarWriteError("CALENDAR_WRITE_UNRESOLVED", "The Calendar change could not be verified. Check the event and Calendar authorization before retrying; reuse the same operation_key for a creation");
  }
  async execute(runtime: GoogleRuntime, input: Json, signal?: AbortSignal): Promise<Json> {
    const operation = input.operation;
    if (!CALENDAR_WRITE_OPERATIONS.has(String(operation))) invalid();
    keys(input, ["operation", "account", "calendar", ...(operation === "calendar_create" ? ["operation_key", "event"] : ["event_id", ...(operation === "calendar_event" ? [] : ["if_etag"]), ...(operation === "calendar_update" ? ["patch"] : [])])]);
    const target = this.target(runtime, input);
    const patch = operation === "calendar_create" ? fields(input.event, true) : operation === "calendar_update" ? fields(input.patch, false) : undefined;
    const operationKey = operation === "calendar_create" ? string(input.operation_key, 128) : undefined;
    const id = operationKey ? `a${hash(`${target.account}\0${target.calendarId}\0${operationKey}`)}` : eventId(input.event_id);
    const generation = this.generation;
    return this.locked(async () => {
      this.current(generation, signal);
      await this.permission(target, signal);
      if (operation === "calendar_create") {
        const fingerprint = hash(JSON.stringify(patch));
        let existing: Json | undefined;
        try { existing = await this.read(target, id, signal); } catch (error) { throwDefiniteRejection(error); /* Insert with the same ID is safe when existence is unknown. */ }
        const verify = (event: Json) => {
          const props = event.extendedProperties as { private?: Json } | undefined;
          if (props?.private?.assistantDraft !== fingerprint || !matches(event, patch!)) throw new CalendarWriteError("CALENDAR_OPERATION_CONFLICT", "This operation_key already belongs to another or changed event. Read that event before proceeding");
          editable(event);
          return { operation, event: normalized(event, target) };
        };
        if (existing) return verify(existing);
        this.current(generation, signal);
        try { await this.api(target, "events.insert", undefined, { ...patch, id, extendedProperties: { private: { assistantDraft: fingerprint } } }, signal); }
        catch (error) { throwDefiniteRejection(error); /* Reconcile a lost response; never invent a new ID. */ }
        let saved: Json;
        try { saved = await this.read(target, id); } catch { return this.unresolved(); }
        return verify(saved);
      }
      const event = await this.read(target, id, signal);
      if (operation === "calendar_event") return { operation, event: normalized(event, target) };
      editable(event); version(event, input.if_etag);
      if (operation === "calendar_request_delete") {
        this.current(generation, signal);
        for (const [token, pending] of this.pending) if (pending.expires <= Date.now()) this.pending.delete(token);
        if (this.pending.size >= 32) throw new CalendarWriteError("CALENDAR_BUSY", "Too many pending confirmations. Cancel one or wait for expiry");
        const token = randomUUID();
        this.pending.set(token, { target, event, expires: Date.now() + TTL });
        return { token, event: normalized(event, target) };
      }
      validateInterval(object(patch!.start ?? event.start), object(patch!.end ?? event.end));
      this.current(generation, signal);
      try { await this.api(target, "events.patch", id, patch, signal); } catch (error) { throwDefiniteRejection(error); /* Read back once; do not blindly replay a patch. */ }
      let saved: Json;
      try { saved = await this.read(target, id); } catch { return this.unresolved(); }
      if (!matches(saved, patch!)) return this.unresolved();
      return { operation, event: normalized(saved, target) };
    });
  }
  async confirm(token: string, chatId: number): Promise<{ deleted: true }> {
    const pending = this.consume(token, chatId);
    const generation = this.generation;
    return this.locked(async () => {
      const { target, event } = pending;
      await this.permission(target);
      const id = eventId(event.id);
      const current = await this.read(target, id);
      editable(current); version(current, event.etag);
      this.current(generation);
      try {
        await this.api(target, "events.delete", id);
        return { deleted: true };
      } catch (error) {
        throwDefiniteRejection(error);
        // A returned tombstone proves deletion. A generic read error does not.
        try { if ((await this.read(target, id)).status === "cancelled") return { deleted: true }; } catch { /* unresolved */ }
        return this.unresolved();
      }
    });
  }
}
