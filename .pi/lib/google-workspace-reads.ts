// Pure Google read handlers shared by the native host. No Pi runtime imports,
// registration, or credential reads beyond what the injected options do.
import { CalendarWrites, CalendarWriteError } from "./google-calendar-writes.js";
import { executePlacesOperation, PLACES_OPERATIONS, type PlacesOperationOptions } from "./google-places.js";
import type { GoogleRuntime } from "./google-transport.js";
import {
  MAX_EVENT_WINDOW_DAYS, MAX_AVAILABILITY_WINDOW_DAYS, MAX_GMAIL_THREADS, MAX_CONTACT_RESULTS,
  requiredSafeString, selectedAccount, commonArgs, parseWindow, maxResults, calendarIds,
  parseAccountStatus, parseAccountAlias, parseCalendars, parseEvents, GoogleCommandError,
  parseGmailSearch, parseGmailThread, parseContactSearchResources, parseContact,
  parseAvailability, findConflicts,
} from "./google-operations.js";

export type GoogleReadOutcome = { ok: true; result: unknown } | { ok: false; code: string; message: string };
export interface GoogleReadOptions extends PlacesOperationOptions {
  run(runtime: GoogleRuntime, args: string[], signal?: AbortSignal): Promise<unknown>;
}
/** Operations this module will execute. Everything else is rejected before any transport call. */
export const GOOGLE_READ_OPERATIONS: ReadonlySet<string> = new Set([
  "account_status", "calendar_list", "calendar_events", "calendar_search", "calendar_availability",
  "calendar_event", "gmail_search", "gmail_thread", "contacts_search",
  "places_search", "places_search_candidates", "places_details",
]);

const ok = (result: unknown): GoogleReadOutcome => ({ ok: true, result });
const fail = (code: string, message: string): GoogleReadOutcome => ({ ok: false, code, message });

export async function executeGoogleRead(
  input: Record<string, unknown>,
  runtime: GoogleRuntime,
  options: GoogleReadOptions,
  signal?: AbortSignal,
): Promise<GoogleReadOutcome> {
  const operation = requiredSafeString(input.operation, 64);
  if (!operation || !GOOGLE_READ_OPERATIONS.has(operation)) return fail("GOOGLE_OPERATION_INVALID", "The Google Workspace operation is invalid");
  if (operation === "calendar_event") {
    // Only the guarded single-event read; CalendarWrites validates keys, account and calendar.
    try { return ok(await new CalendarWrites(options.run).execute(runtime, input, signal)); }
    catch (error) {
      if (error instanceof CalendarWriteError) {
        if (error.code === "CALENDAR_WRITES_NOT_CONFIGURED") return fail("CALENDAR_READ_NOT_CONFIGURED", "Single-event reads require configured account and calendar targets");
        if (error.code === "CALENDAR_WRITE_FORBIDDEN") return fail("CALENDAR_READ_FORBIDDEN", "Single-event reads require the configured account and editor or owner Calendar access");
        if (error.code === "CALENDAR_AUTH_REQUIRED") return fail(error.code, "Single-event reads require the configured Calendar authorization");
        return fail(error.code, error.message);
      }
      return fail("GOOGLE_CALENDAR_UNAVAILABLE", "Calendar is unavailable. Check Google authorization and Calendar access before retrying");
    }
  }
  const account = selectedAccount(input, runtime);
  const isPlacesOperation = PLACES_OPERATIONS.has(operation);
  if (operation !== "calendar_availability" && !isPlacesOperation && !account) {
    return fail(
      "GOOGLE_ACCOUNT_REQUIRED",
      "Choose a Google account or configure a default account",
    );
  }
  if (input.account !== undefined && !requiredSafeString(input.account, 254)) {
    return fail("GOOGLE_ACCOUNT_INVALID", "The Google account is invalid");
  }

  if (isPlacesOperation) {
    const places = await executePlacesOperation(operation, input, runtime, options, signal);
    return places.ok ? ok(places.result) : fail(places.code, places.message);
  }

  if (operation === "contacts_search") {
    const query = requiredSafeString(input.query, 200);
    const maximum = maxResults(input, 10);
    if (!query || query.startsWith("-") || !maximum || maximum > MAX_CONTACT_RESULTS) {
      return fail("GOOGLE_CONTACTS_INPUT_INVALID", "The Google Contacts search request is invalid");
    }
    try {
      const payload = await options.run(runtime, [
        ...commonArgs(account!), "contacts", "search", query, `--max=${maximum}`,
      ], signal);
      const matched = parseContactSearchResources(payload, maximum);
      const parsedContacts = await Promise.all(matched.resources.map(async (resource) => {
        const detailPayload = await options.run(runtime, [
          ...commonArgs(account!), "contacts", "get", resource,
        ], signal);
        return parseContact(detailPayload, resource);
      }));
      return ok({
        operation: "contacts_search",
        account: account!,
        query,
        contacts: parsedContacts.map((parsed) => parsed.contact),
        truncated: matched.truncated || parsedContacts.some((parsed) => parsed.truncated),
      });
    } catch {
      return fail("GOOGLE_CONTACTS_UNAVAILABLE", `Google Contacts is temporarily unavailable for account ${account}`);
    }
  }

  if (operation === "gmail_search") {
    const query = requiredSafeString(input.query, 500);
    const maximum = maxResults(input, 10);
    if (!query || query.startsWith("-") || !maximum || maximum > MAX_GMAIL_THREADS) {
      return fail("GOOGLE_GMAIL_INPUT_INVALID", "The Gmail search request is invalid");
    }
    try {
      const payload = await options.run(runtime, [
        ...commonArgs(account!), "gmail", "search", query, `--max=${maximum}`,
      ], signal);
      return ok(parseGmailSearch(payload, account!, query, maximum));
    } catch {
      return fail("GOOGLE_GMAIL_UNAVAILABLE", `Gmail is temporarily unavailable for account ${account}`);
    }
  }

  if (operation === "gmail_thread") {
    const threadId = requiredSafeString(input.thread_id, 256);
    if (!threadId || threadId.startsWith("-")) {
      return fail("GOOGLE_GMAIL_INPUT_INVALID", "The Gmail thread request is invalid");
    }
    try {
      const payload = await options.run(runtime, [
        ...commonArgs(account!), "gmail", "thread", "get", threadId, "--sanitize-content",
      ], signal);
      return ok(parseGmailThread(payload, account!, threadId));
    } catch {
      return fail("GOOGLE_GMAIL_UNAVAILABLE", `Gmail is temporarily unavailable for account ${account}`);
    }
  }

  if (operation === "calendar_list") {
    const maximum = maxResults(input, 50);
    if (!maximum) return fail("GOOGLE_CALENDAR_INPUT_INVALID", "The Google Calendar request is invalid");
    try {
      const payload = await options.run(runtime, [...commonArgs(account!), "calendar", "calendars", `--max=${maximum}`], signal);
      return ok(parseCalendars(payload, account!));
    } catch {
      return fail("GOOGLE_CALENDAR_UNAVAILABLE", `Google Calendar is temporarily unavailable for account ${account}`);
    }
  }

  if (operation === "calendar_events" || operation === "calendar_search") {
    const window = parseWindow(input, MAX_EVENT_WINDOW_DAYS);
    if (!window) {
      return fail("GOOGLE_CALENDAR_WINDOW_INVALID", "Choose a valid Google Calendar window of 366 days or less");
    }
    const selectedCalendars = calendarIds(input);
    const maximum = maxResults(input, 25);
    const query = operation === "calendar_search" ? requiredSafeString(input.query, 200) : undefined;
    const timeZone = input.time_zone === undefined ? undefined : requiredSafeString(input.time_zone, 64);
    if (!selectedCalendars || !maximum || (operation === "calendar_search" && !query) || (input.time_zone !== undefined && !timeZone)) {
      return fail("GOOGLE_CALENDAR_INPUT_INVALID", "The Google Calendar request is invalid");
    }
    const args = [
      `--from=${window.from}`,
      `--to=${window.to}`,
      `--max=${maximum}`,
      ...(query ? [`--query=${query}`] : []),
      ...(timeZone ? [`--timezone=${timeZone}`] : []),
      "--sort=start",
    ];
    try {
      const results = [];
      for (const calendarId of selectedCalendars) {
        // Single positional IDs preserve Google's primary alias and avoid name resolution.
        const payload = await options.run(runtime, [...commonArgs(account!), "calendar", "events", calendarId, ...args], signal);
        results.push(parseEvents(payload, operation, account!, maximum, query));
      }
      const events = results.flatMap((result, index) =>
        (result.events as Array<Record<string, unknown>>).map((event): Record<string, unknown> => ({
          ...event, calendarId: event.calendarId ?? selectedCalendars[index],
        })),
      ).sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)));
      return ok({ operation, account, ...(query ? { query } : {}),
        events: events.slice(0, maximum),
        truncated: events.length > maximum || results.some((result) => result.truncated),
      });
    } catch (error) {
      // Fixed classifications retain useful diagnostics without exposing stderr.
      if (error instanceof GoogleCommandError && error.code !== "UNKNOWN") {
        return fail(`GOOGLE_CALENDAR_${error.code}`, `Google Calendar request failed: ${error.code}`);
      }
      return fail("GOOGLE_CALENDAR_UNAVAILABLE", `Google Calendar is temporarily unavailable for account ${account}`);
    }
  }

  if (operation === "calendar_availability") {
    const window = parseWindow(input, MAX_AVAILABILITY_WINDOW_DAYS);
    if (!window) {
      return fail("GOOGLE_CALENDAR_WINDOW_INVALID", "Choose a valid Google Calendar availability window of 31 days or less");
    }
    const rawAccounts = input.accounts === undefined ? (runtime.account ? [runtime.account] : undefined) : input.accounts;
    const accounts = Array.isArray(rawAccounts)
      ? rawAccounts.map((value) => requiredSafeString(value, 254))
      : undefined;
    const selectedCalendars = calendarIds(input);
    if (!accounts || accounts.length < 1 || accounts.length > 8 || !accounts.every((value): value is string => Boolean(value)) || !selectedCalendars) {
      return fail("GOOGLE_ACCOUNT_REQUIRED", "Choose one or more valid Google accounts");
    }
    const availability: Array<ReturnType<typeof parseAvailability>> = [];
    for (const selected of [...new Set(accounts)]) {
      try {
        const payload = await options.run(runtime, [
          ...commonArgs(selected),
          "calendar",
          "freebusy",
          ...selectedCalendars.map((id) => `--cal=${id}`),
          `--from=${window.from}`,
          `--to=${window.to}`,
        ], signal);
        availability.push(parseAvailability(payload, selected));
      } catch {
        return fail("GOOGLE_CALENDAR_UNAVAILABLE", `Google Calendar is temporarily unavailable for account ${selected}`);
      }
    }
    const conflictResult = findConflicts(availability);
    return ok({
      operation: "calendar_availability",
      from: window.from,
      to: window.to,
      accounts: availability,
      conflicts: conflictResult.conflicts,
      truncated: availability.some((item) => item.truncated) || conflictResult.truncated,
    });
  }

  if (operation !== "account_status") {
    return fail("GOOGLE_OPERATION_INVALID", "The Google Workspace operation is invalid");
  }
  try {
    const payload = await options.run(runtime,
      [...commonArgs(account!), "auth", "list"],
      signal,
    );
    const direct = parseAccountStatus(payload, account!);
    if (direct.authenticated) return ok(direct);
    const aliases = await options.run(runtime, [...commonArgs(account!), "auth", "alias", "list"], signal);
    const resolved = parseAccountAlias(aliases, account!);
    return ok(resolved ? parseAccountStatus(payload, account!, resolved) : direct);
  } catch {
    return fail("GOOGLE_WORKSPACE_UNAVAILABLE", "Google Workspace is temporarily unavailable");
  }
}
