import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const calendar = await import(pathToFileURL(join(import.meta.dirname, "../.pi/lib/google-calendar-writes.ts")).href);
afterEach(() => vi.useRealTimers());

it("enables writes only with complete stable IDs bound to this instance", () => {
  const config = { instance: "isaac", account: "owner@example.com", personal: "personal-id", thingsToDo: "todo-id" };
  expect(calendar.parseCalendarWriteConfig(JSON.stringify(config), "isaac")).toMatchObject({ personal: "personal-id" });
  for (const value of [undefined, "malformed", "{}", JSON.stringify({ ...config, personal: "primary" }),
    JSON.stringify({ ...config, thingsToDo: "personal-id" }), JSON.stringify({ ...config, account: "alias" })]) {
    expect(calendar.parseCalendarWriteConfig(value, "isaac")).toBeUndefined();
  }
  expect(calendar.parseCalendarWriteConfig(JSON.stringify(config), "emma")).toBeUndefined();
  expect(calendar.parseCalendarWriteConfig(JSON.stringify(config), undefined)).toBeUndefined();
});

function fixture() {
  const events = new Map<string, Record<string, unknown>>();
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  let loseResponse = false;
  let role = "owner";
  const runtime = { account: "owner@example.com", calendarWrites: {
    account: "owner@example.com", personal: "personal-id", thingsToDo: "todo-id",
  } };
  const run = vi.fn(async (_runtime: unknown, args: string[]) => {
    const method = args[args.indexOf("v3") + 1]!;
    const params = JSON.parse(args.find(arg => arg.startsWith("--params="))!.slice(9));
    const body = JSON.parse(args.find(arg => arg.startsWith("--body="))?.slice(7) ?? "{}");
    if (method === "calendar.calendarList.get") return { id: params.calendarId, accessRole: role };
    if (method === "calendar.events.get") {
      const event = events.get(params.eventId);
      if (!event) throw new Error("synthetic not found");
      return structuredClone(event);
    }
    writes.push({ method, body });
    if (method === "calendar.events.insert") {
      if (events.has(body.id)) throw new Error("synthetic conflict");
      events.set(body.id, { ...body, etag: '"v1"', status: "confirmed" });
    } else if (method === "calendar.events.patch") {
      events.set(params.eventId, { ...events.get(params.eventId), ...body, etag: '"v2"' });
    } else if (method === "calendar.events.delete") {
      events.set(params.eventId, { id: params.eventId, status: "cancelled" });
    } else throw new Error("unexpected method");
    if (loseResponse) throw new Error("synthetic timeout after commit");
    return method === "calendar.events.delete" ? {} : structuredClone(events.get(body.id ?? params.eventId));
  });
  const app = new calendar.CalendarWrites(run);
  const draft = { summary: "Test event", start: { dateTime: "2026-11-01T01:30:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-11-01T01:30:00-05:00", timeZone: "America/New_York" } };
  const create = (patch = {}) => app.execute(runtime, { operation: "calendar_create", operation_key: "synthetic-operation-1", event: draft, ...patch });
  return { app, runtime, run, events, writes, draft, create, loseResponse: () => { loseResponse = true; }, readOnly: () => { role = "reader"; } };
}

it("creates with a stable ID, reconciles lost responses, and preserves unrelated fields on patch", async () => {
  const f = fixture(); f.loseResponse();
  const created = await f.create();
  expect(created.event.summary).toBe("Test event");
  expect((await f.create()).event.id).toBe(created.event.id);
  const restarted = new calendar.CalendarWrites(f.run);
  expect((await restarted.execute(f.runtime, { operation: "calendar_create", operation_key: "synthetic-operation-1", event: f.draft })).event.id).toBe(created.event.id);
  expect(f.events.size).toBe(1);
  const original = f.events.get(created.event.id)!;
  original.description = "Keep this"; original.reminders = { useDefault: true };
  const updated = await f.app.execute(f.runtime, { operation: "calendar_update", event_id: created.event.id, if_etag: created.event.etag, patch: { location: "Park" } });
  expect(updated.event.location).toBe("Park");
  expect(f.events.get(created.event.id)).toMatchObject({ description: "Keep this", reminders: { useDefault: true } });
  expect(f.writes.at(-1)!.body).toEqual({ location: "Park" });
  for (const [, args] of f.run.mock.calls) {
    expect(args).toContain("--gmail-no-send");
    if (args.includes("calendar.events.get") || args.includes("calendar.calendarList.get")) expect(args).toContain("--readonly");
    else { expect(args).toContain("--allow-write"); expect(args).not.toContain("--readonly"); }
  }
});

it("validates all-day dates, offsets and DST zones, rejects empty or unsupported patches", async () => {
  const f = fixture();
  await expect(f.create({ event: { summary: "All day", start: { date: "2026-10-01" }, end: { date: "2026-10-02" } } })).resolves.toMatchObject({ event: { start: { date: "2026-10-01" } } });
  for (const event of [
    { ...f.draft, attendees: [{ email: "other@example.com" }] },
    { ...f.draft, start: { date: "2026-02-30" }, end: { date: "2026-03-03" } },
    { ...f.draft, start: { dateTime: "2026-03-08T02:30:00-05:00", timeZone: "America/New_York" } },
    { ...f.draft, end: { date: "2026-11-02" } },
  ]) await expect(f.create({ event })).rejects.toMatchObject({ code: "CALENDAR_INPUT_INVALID" });
  await expect(f.app.execute(f.runtime, { operation: "calendar_update", event_id: "abc", if_etag: '"v1"', patch: {} })).rejects.toMatchObject({ code: "CALENDAR_INPUT_INVALID" });
});

it("blocks wrong accounts/calendars, excluded events, missing permissions, stale versions and changed operation keys", async () => {
  const f = fixture();
  for (const patch of [{ account: "work" }, { calendar: "holiday" }, { calendar_id: "unapproved" }]) {
    await expect(f.create(patch)).rejects.toBeDefined();
  }
  expect(f.writes).toHaveLength(0);
  const created = await f.create();
  await expect(f.create({ event: { ...f.draft, summary: "Different" } })).rejects.toMatchObject({ code: "CALENDAR_OPERATION_CONFLICT" });
  const request = { operation: "calendar_update", event_id: created.event.id, if_etag: '"v1"', patch: { summary: "Changed" } };
  const original = structuredClone(f.events.get(created.event.id)!);
  for (const fields of [{ attendees: [{ email: "guest@example.com" }] }, { attendeesOmitted: true }, { recurrence: ["RRULE:FREQ=DAILY"] }, { recurringEventId: "parent" }, { eventType: "birthday" }, { organizer: { self: false } }]) {
    f.events.set(created.event.id, { ...original, ...fields });
    await expect(f.app.execute(f.runtime, request)).rejects.toMatchObject({ code: "CALENDAR_EVENT_EXCLUDED" });
  }
  f.events.set(created.event.id, { ...original, etag: '"changed"' });
  await expect(f.app.execute(f.runtime, request)).rejects.toMatchObject({ code: "CALENDAR_EVENT_CHANGED" });
  f.readOnly();
  await expect(f.create({ operation_key: "another" })).rejects.toMatchObject({ code: "CALENDAR_WRITE_FORBIDDEN" });
  expect(f.writes).toHaveLength(1);
});

it("requires a bound, unexpired, single-use user confirmation and rechecks the event before deletion", async () => {
  vi.useFakeTimers();
  const f = fixture(); const created = await f.create();
  const request = () => f.app.execute(f.runtime, { operation: "calendar_request_delete", event_id: created.event.id, if_etag: created.event.etag });
  const pending = await request();
  expect(f.writes).toHaveLength(1);
  f.app.bind(pending.token, 11);
  await expect(f.app.confirm(pending.token, 22)).rejects.toMatchObject({ code: "CALENDAR_CONFIRMATION_EXPIRED" });
  f.events.get(created.event.id)!.etag = '"changed"';
  await expect(f.app.confirm(pending.token, 11)).rejects.toMatchObject({ code: "CALENDAR_EVENT_CHANGED" });
  f.events.get(created.event.id)!.etag = created.event.etag;
  const cancelled = await request(); f.app.bind(cancelled.token, 11); f.app.cancel(cancelled.token, 11);
  await expect(f.app.confirm(cancelled.token, 11)).rejects.toBeDefined();
  const expired = await request(); f.app.bind(expired.token, 11); vi.advanceTimersByTime(600_001);
  await expect(f.app.confirm(expired.token, 11)).rejects.toBeDefined();
  const fresh = await request(); f.app.bind(fresh.token, 11); f.loseResponse();
  await expect(f.app.confirm(fresh.token, 11)).resolves.toMatchObject({ deleted: true });
  await expect(f.app.confirm(fresh.token, 11)).rejects.toBeDefined();
  expect(f.writes.filter(w => w.method === "calendar.events.delete")).toHaveLength(1);
});

it("reports unresolved writes without false success or a blind retry", async () => {
  const f = fixture(); const created = await f.create();
  f.run.mockImplementation(async (_runtime, args) => {
    if (args.includes("calendar.calendarList.get")) return { id: "personal-id", accessRole: "owner" };
    if (args.includes("calendar.events.get")) return structuredClone(f.events.get(created.event.id)!);
    throw new Error("Synthetic failure before commit");
  });
  await expect(f.app.execute(f.runtime, { operation: "calendar_update", event_id: created.event.id, if_etag: created.event.etag, patch: { summary: "New" } })).rejects.toMatchObject({ code: "CALENDAR_WRITE_UNRESOLVED" });
  const pending = await f.app.execute(f.runtime, { operation: "calendar_request_delete", event_id: created.event.id, if_etag: created.event.etag });
  f.app.bind(pending.token, 11);
  await expect(f.app.confirm(pending.token, 11)).rejects.toMatchObject({ code: "CALENDAR_WRITE_UNRESOLVED" });
  expect(f.run.mock.calls.filter(([, args]) => args.includes("calendar.events.delete"))).toHaveLength(1);
});
