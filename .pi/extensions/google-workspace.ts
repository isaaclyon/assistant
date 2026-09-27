import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerTelegramSection, presentTelegramSection } from "@llblab/pi-telegram/sections";
import { CALENDAR_WRITE_OPERATIONS, CalendarWrites, CalendarWriteError } from "../lib/google-calendar-writes.ts";
import {
  executePlacesOperation,
  MAX_PLACE_CANDIDATES,
  PLACES_OPERATIONS,
  type PlacesOperationOptions,
} from "../lib/google-places.ts";
import { hasGogRuntime, resolveGoogleRuntime, runGogJson, type GoogleRuntime } from "../lib/google-transport.ts";
export { fetchPlaceDetails, fetchPlaceSearch } from "../lib/google-places.ts";
export { resolveGoogleRuntime, runGogJson } from "../lib/google-transport.ts";
import {
  MAX_EVENT_WINDOW_DAYS,
  MAX_AVAILABILITY_WINDOW_DAYS,
  MAX_GMAIL_THREADS,
  MAX_CONTACT_RESULTS,
  requiredSafeString,
  selectedAccount,
  commonArgs,
  parseWindow,
  maxResults,
  calendarIds,
  parseAccountStatus,
  parseAccountAlias,
  parseCalendars,
  parseEvents,
  parseGmailSearch,
  parseGmailThread,
  parseContactSearchResources,
  parseContact,
  parseAvailability,
  findConflicts
} from "../lib/google-operations.ts";

interface GoogleToolDetails {
  ok: boolean;
  result: unknown;
  error: { code: string; message: string } | null;
}

interface GoogleWorkspaceRegistrationOptions extends PlacesOperationOptions {
  resolveRuntime(): Promise<GoogleRuntime>;
  run(runtime: GoogleRuntime, args: string[], signal?: AbortSignal): Promise<unknown>;
}

interface MinimalPiApi {
  registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]): void;
  on?: ExtensionAPI["on"];
}

function success(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: GoogleToolDetails;
} {
  const details = { ok: true, result, error: null } satisfies GoogleToolDetails;
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function failure(code: string, message: string): {
  content: Array<{ type: "text"; text: string }>;
  details: GoogleToolDetails;
} {
  const details = {
    ok: false,
    result: null,
    error: { code, message },
  } satisfies GoogleToolDetails;
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

const accountParameter = Type.Optional(Type.String({ minLength: 1, maxLength: 254 }));
const calendarIdsParameter = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
  minItems: 1,
  maxItems: 20,
}));
const windowParameters = {
  from: Type.String({ minLength: 10, maxLength: 64 }),
  to: Type.String({ minLength: 10, maxLength: 64 }),
};

const calendarParameter = Type.Optional(Type.Union([Type.Literal("personal"), Type.Literal("things_to_do")]));
const eventTimeParameter = Type.Union([
  Type.Object({ date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }) }, { additionalProperties: false }),
  Type.Object({ dateTime: Type.String({ minLength: 20, maxLength: 64 }), timeZone: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
]);
const eventFields = {
  summary: Type.String({ minLength: 1, maxLength: 500 }),
  description: Type.Optional(Type.String({ maxLength: 4_000 })),
  location: Type.Optional(Type.String({ maxLength: 500 })),
  start: eventTimeParameter, end: eventTimeParameter,
};
const eventTarget = {
  account: accountParameter, calendar: calendarParameter,
  event_id: Type.String({ minLength: 1, maxLength: 1_024 }),
};
const etagParameter = Type.String({ minLength: 1, maxLength: 200 });
const CALENDAR_SECTION = "assistant/calendar-confirmation";
function calendarFailure(error: unknown) {
  return error instanceof CalendarWriteError ? { code: error.code, message: error.message } : {
    code: "GOOGLE_CALENDAR_UNAVAILABLE",
    message: "Calendar is unavailable. Check Google authorization and Calendar access before retrying",
  };
}

export function registerGoogleWorkspaceTool(
  pi: MinimalPiApi,
  options: GoogleWorkspaceRegistrationOptions,
): void {
  const calendarWrites = new CalendarWrites(options.run);
  let unregister: (() => void) | undefined;
  let pending: { token: string; event: Record<string, unknown> } | undefined;
  let presenting = false;
  const clear = () => { unregister?.(); unregister = undefined; calendarWrites.clear(); pending = undefined; presenting = false; };
  pi.on?.("session_shutdown", clear);
  pi.on?.("session_start", () => {
    clear();
    if (!process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID) return;
    unregister = registerTelegramSection({
      id: CALENDAR_SECTION, label: "📅 Calendar confirmations", order: 26,
      render(ctx) {
        const item = pending; pending = undefined;
        if (!item) return { text: "No event deletion is awaiting confirmation.", parseMode: "plain" };
        calendarWrites.bind(item.token, ctx.chatId);
        const start = item.event.start as Record<string, unknown>;
        const end = item.event.end as Record<string, unknown>;
        return {
          text: `Delete event: ${item.event.summary ?? "Untitled"}\nCalendar: ${item.event.calendar === "personal" ? "Personal" : "Things to Do"}\n` +
            `Start: ${start.date ?? start.dateTime}\nEnd: ${end.date ?? end.dateTime}${end.date ? " (exclusive)" : ""}\n` +
            `${start.timeZone ? `Time zone: ${start.timeZone}\n` : ""}\nThis confirmation expires in 10 minutes and applies only to this version.`,
          parseMode: "plain",
          replyMarkup: { inline_keyboard: [[
            { text: "Confirm deletion", callback_data: ctx.callbackData("confirm", item.token) },
            { text: "Cancel", callback_data: ctx.callbackData("cancel", item.token) },
          ]] },
        };
      },
      async handleCallback(ctx) {
        if (ctx.action !== "confirm" && ctx.action !== "cancel") return "pass";
        await ctx.answerCallback();
        let text: string;
        try {
          if (ctx.action === "cancel") { calendarWrites.cancel(ctx.payload, ctx.chatId); text = "Cancelled. The event was not deleted."; }
          else { await calendarWrites.confirm(ctx.payload, ctx.chatId); text = "Event deleted."; }
        } catch (error) { text = calendarFailure(error).message; }
        // A failed Telegram edit must never replay the mutation.
        await ctx.edit({ text, parseMode: "plain", replyMarkup: { inline_keyboard: [] } });
        return "handled";
      },
    });
  });
  pi.registerTool({
    name: "google_workspace",
    label: "Google Workspace",
    description:
      "Run typed Google Workspace reads, guarded Calendar changes in Personal or Things to Do, and locally metered Google Places lookup. Event deletion requires a direct user confirmation button.",
    promptSnippet: "Inspect Google Workspace, manage individual personal Calendar events, and look up places",
    promptGuidelines: [
      "Use google_workspace only for its typed operations; never invoke gogcli through shell commands.",
      "Gmail and Contacts remain read-only. Calendar writes support only individual events without guests or recurrence in Personal (default) and Things to Do. Act on clear create/edit requests; clarify material ambiguity.",
      "Read calendar_event before updating or requesting deletion, and pass its if_etag. Patch only requested fields. Timed events need an explicit offset and matching IANA timeZone; all-day end dates are exclusive.",
      "For calendar_create choose one unique operation_key and reuse it unchanged on retries. Never retry an unresolved creation with a new key. Claim success only from verified tool results.",
      "calendar_request_delete sends direct user-only confirmation buttons. Wait for the user; the tool cannot approve deletion. Never bypass confirmation through another tool or command.",
      "Use places_search_candidates for multi-place, comparison, or best/top-rated requests and choose which candidates to surface; the list is bounded and may be incomplete. Places requests may be blocked by a local monthly limit.",
      "Use rich_details only when ratings, hours, contact information, price, or reviews are requested. Attribute those results to Google Maps and keep review author/source links.",
    ],
    parameters: Type.Union([
      Type.Object({ operation: Type.Literal("calendar_event"), ...eventTarget }, { additionalProperties: false }),
      Type.Object({ operation: Type.Literal("calendar_create"), account: accountParameter, calendar: calendarParameter,
        operation_key: Type.String({ minLength: 1, maxLength: 128 }), event: Type.Object(eventFields, { additionalProperties: false }),
      }, { additionalProperties: false }),
      Type.Object({ operation: Type.Literal("calendar_update"), ...eventTarget, if_etag: etagParameter,
        patch: Type.Partial(Type.Object(eventFields, { additionalProperties: false, minProperties: 1 })),
      }, { additionalProperties: false }),
      Type.Object({ operation: Type.Literal("calendar_request_delete"), ...eventTarget, if_etag: etagParameter }, { additionalProperties: false }),
      Type.Object({ operation: Type.Literal("account_status"), account: accountParameter }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("calendar_list"),
        account: accountParameter,
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("calendar_events"),
        account: accountParameter,
        calendar_ids: calendarIdsParameter,
        ...windowParameters,
        time_zone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("calendar_search"),
        account: accountParameter,
        calendar_ids: calendarIdsParameter,
        query: Type.String({ minLength: 1, maxLength: 200 }),
        ...windowParameters,
        time_zone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("calendar_availability"),
        accounts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 254 }), {
          minItems: 1,
          maxItems: 8,
        })),
        calendar_ids: calendarIdsParameter,
        ...windowParameters,
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("gmail_search"),
        account: accountParameter,
        query: Type.String({ minLength: 1, maxLength: 500 }),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GMAIL_THREADS })),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("gmail_thread"),
        account: accountParameter,
        thread_id: Type.String({ minLength: 1, maxLength: 256 }),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("contacts_search"),
        account: accountParameter,
        query: Type.String({ minLength: 1, maxLength: 200 }),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONTACT_RESULTS })),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("places_search"),
        field_profile: Type.Literal("identity"),
        query: Type.String({ minLength: 1, maxLength: 200 }),
        language: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
        region: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("places_search_candidates"),
        query: Type.String({ minLength: 1, maxLength: 200 }),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PLACE_CANDIDATES })),
        language: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
        region: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
      }, { additionalProperties: false }),
      Type.Object({
        operation: Type.Literal("places_details"),
        field_profile: Type.Union([Type.Literal("identity"), Type.Literal("rich_details")]),
        place_id: Type.String({ minLength: 1, maxLength: 263 }),
        language: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
        region: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
      }, { additionalProperties: false }),
    ]),
    async execute(_id, params, signal) {
      const input = params as Record<string, unknown>;
      let runtime: GoogleRuntime;
      try {
        runtime = await options.resolveRuntime();
      } catch {
        return failure("GOOGLE_WORKSPACE_UNAVAILABLE", "Google Workspace is temporarily unavailable");
      }
      const operation = requiredSafeString(input.operation, 64);
      if (!operation) return failure("GOOGLE_OPERATION_INVALID", "The Google Workspace operation is invalid");
      if (CALENDAR_WRITE_OPERATIONS.has(operation)) {
        try {
          if (operation !== "calendar_request_delete") return success(await calendarWrites.execute(runtime, input, signal));
          if (!unregister) throw new CalendarWriteError("CALENDAR_CONFIRMATION_UNAVAILABLE", "Event deletion requires an active Telegram session");
          if (presenting) throw new CalendarWriteError("CALENDAR_BUSY", "Another deletion preview is being presented");
          presenting = true;
          let token: string | undefined;
          try {
            const preview = await calendarWrites.execute(runtime, input, signal);
            token = preview.token as string;
            pending = { token, event: preview.event as Record<string, unknown> };
            await presentTelegramSection(CALENDAR_SECTION);
            return success({ operation, status: "awaiting_confirmation", message: "Confirmation buttons sent. Wait for the user; the event has not been deleted." });
          } catch (error) {
            if (token) calendarWrites.discard(token);
            throw error;
          } finally { pending = undefined; presenting = false; }
        } catch (error) { const selected = calendarFailure(error); return failure(selected.code, selected.message); }
      }
      const account = selectedAccount(input, runtime);
      const isPlacesOperation = PLACES_OPERATIONS.has(operation);
      if (operation !== "calendar_availability" && !isPlacesOperation && !account) {
        return failure(
          "GOOGLE_ACCOUNT_REQUIRED",
          "Choose a Google account or configure a default account",
        );
      }
      if (input.account !== undefined && !requiredSafeString(input.account, 254)) {
        return failure("GOOGLE_ACCOUNT_INVALID", "The Google account is invalid");
      }

      if (isPlacesOperation) {
        const places = await executePlacesOperation(operation, input, runtime, options, signal);
        return places.ok ? success(places.result) : failure(places.code, places.message);
      }

      if (operation === "contacts_search") {
        const query = requiredSafeString(input.query, 200);
        const maximum = maxResults(input, 10);
        if (!query || query.startsWith("-") || !maximum || maximum > MAX_CONTACT_RESULTS) {
          return failure("GOOGLE_CONTACTS_INPUT_INVALID", "The Google Contacts search request is invalid");
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
          return success({
            operation: "contacts_search",
            account: account!,
            query,
            contacts: parsedContacts.map((parsed) => parsed.contact),
            truncated: matched.truncated || parsedContacts.some((parsed) => parsed.truncated),
          });
        } catch {
          return failure("GOOGLE_CONTACTS_UNAVAILABLE", `Google Contacts is temporarily unavailable for account ${account}`);
        }
      }

      if (operation === "gmail_search") {
        const query = requiredSafeString(input.query, 500);
        const maximum = maxResults(input, 10);
        if (!query || query.startsWith("-") || !maximum || maximum > MAX_GMAIL_THREADS) {
          return failure("GOOGLE_GMAIL_INPUT_INVALID", "The Gmail search request is invalid");
        }
        try {
          const payload = await options.run(runtime, [
            ...commonArgs(account!), "gmail", "search", query, `--max=${maximum}`,
          ], signal);
          return success(parseGmailSearch(payload, account!, query, maximum));
        } catch {
          return failure("GOOGLE_GMAIL_UNAVAILABLE", `Gmail is temporarily unavailable for account ${account}`);
        }
      }

      if (operation === "gmail_thread") {
        const threadId = requiredSafeString(input.thread_id, 256);
        if (!threadId || threadId.startsWith("-")) {
          return failure("GOOGLE_GMAIL_INPUT_INVALID", "The Gmail thread request is invalid");
        }
        try {
          const payload = await options.run(runtime, [
            ...commonArgs(account!), "gmail", "thread", "get", threadId, "--sanitize-content",
          ], signal);
          return success(parseGmailThread(payload, account!, threadId));
        } catch {
          return failure("GOOGLE_GMAIL_UNAVAILABLE", `Gmail is temporarily unavailable for account ${account}`);
        }
      }

      if (operation === "calendar_list") {
        const maximum = maxResults(input, 50);
        if (!maximum) return failure("GOOGLE_CALENDAR_INPUT_INVALID", "The Google Calendar request is invalid");
        try {
          const payload = await options.run(runtime, [...commonArgs(account!), "calendar", "calendars", `--max=${maximum}`], signal);
          return success(parseCalendars(payload, account!));
        } catch {
          return failure("GOOGLE_CALENDAR_UNAVAILABLE", `Google Calendar is temporarily unavailable for account ${account}`);
        }
      }

      if (operation === "calendar_events" || operation === "calendar_search") {
        const window = parseWindow(input, MAX_EVENT_WINDOW_DAYS);
        if (!window) {
          return failure("GOOGLE_CALENDAR_WINDOW_INVALID", "Choose a valid Google Calendar window of 366 days or less");
        }
        const selectedCalendars = calendarIds(input);
        const maximum = maxResults(input, 25);
        const query = operation === "calendar_search" ? requiredSafeString(input.query, 200) : undefined;
        const timeZone = input.time_zone === undefined ? undefined : requiredSafeString(input.time_zone, 64);
        if (!selectedCalendars || !maximum || (operation === "calendar_search" && !query) || (input.time_zone !== undefined && !timeZone)) {
          return failure("GOOGLE_CALENDAR_INPUT_INVALID", "The Google Calendar request is invalid");
        }
        const args = [
          ...commonArgs(account!),
          "calendar",
          "events",
          // gog accepts one positional calendar ID; multiple calendars use repeated --cal.
          ...selectedCalendars.map((id) => `--cal=${id}`),
          `--from=${window.from}`,
          `--to=${window.to}`,
          `--max=${maximum}`,
          ...(query ? [`--query=${query}`] : []),
          ...(timeZone ? [`--timezone=${timeZone}`] : []),
          "--sort=start",
        ];
        try {
          const payload = await options.run(runtime, args, signal);
          return success(parseEvents(payload, operation, account!, maximum, query));
        } catch {
          return failure("GOOGLE_CALENDAR_UNAVAILABLE", `Google Calendar is temporarily unavailable for account ${account}`);
        }
      }

      if (operation === "calendar_availability") {
        const window = parseWindow(input, MAX_AVAILABILITY_WINDOW_DAYS);
        if (!window) {
          return failure("GOOGLE_CALENDAR_WINDOW_INVALID", "Choose a valid Google Calendar availability window of 31 days or less");
        }
        const rawAccounts = input.accounts === undefined ? (runtime.account ? [runtime.account] : undefined) : input.accounts;
        const accounts = Array.isArray(rawAccounts)
          ? rawAccounts.map((value) => requiredSafeString(value, 254))
          : undefined;
        const selectedCalendars = calendarIds(input);
        if (!accounts || accounts.length < 1 || accounts.length > 8 || !accounts.every((value): value is string => Boolean(value)) || !selectedCalendars) {
          return failure("GOOGLE_ACCOUNT_REQUIRED", "Choose one or more valid Google accounts");
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
            return failure("GOOGLE_CALENDAR_UNAVAILABLE", `Google Calendar is temporarily unavailable for account ${selected}`);
          }
        }
        const conflictResult = findConflicts(availability);
        return success({
          operation: "calendar_availability",
          from: window.from,
          to: window.to,
          accounts: availability,
          conflicts: conflictResult.conflicts,
          truncated: availability.some((item) => item.truncated) || conflictResult.truncated,
        });
      }

      if (operation !== "account_status") {
        return failure("GOOGLE_OPERATION_INVALID", "The Google Workspace operation is invalid");
      }
      try {
        const payload = await options.run(runtime,
          [...commonArgs(account!), "auth", "list"],
          signal,
        );
        const direct = parseAccountStatus(payload, account!);
        if (direct.authenticated) return success(direct);
        const aliases = await options.run(runtime, [...commonArgs(account!), "auth", "alias", "list"], signal);
        const resolved = parseAccountAlias(aliases, account!);
        return success(resolved ? parseAccountStatus(payload, account!, resolved) : direct);
      } catch {
        return failure("GOOGLE_WORKSPACE_UNAVAILABLE", "Google Workspace is temporarily unavailable");
      }
    },
  });
}

export default function googleWorkspaceExtension(pi: ExtensionAPI): void {
  registerGoogleWorkspaceTool(pi, {
    resolveRuntime: resolveGoogleRuntime,
    async run(runtime, args, signal) {
      // Places does not need gog, so a missing gog setup fails only the
      // Workspace operation that tried to use it.
      if (!hasGogRuntime(runtime)) throw new Error("Google Workspace command failed");
      return await runGogJson({
        binary: runtime.binary,
        passwordFile: runtime.passwordFile,
        gogHome: runtime.gogHome,
        args,
        // Discovery DELETE returns HTTP 204 with no JSON body. Only this exact
        // internally owned method may treat an empty successful response as {}.
        allowEmptyOutput: args[5] === "--force" && args.slice(6, 11).join(" ") === "api call calendar v3 calendar.events.delete",
        ...(signal ? { signal } : {}),
      });
    },
  });
}
