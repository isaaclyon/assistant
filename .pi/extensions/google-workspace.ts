import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { openGooglePlacesGateway } from "../../src/google-places-gateway.ts";
import { fetchPlaceDetails, fetchPlaceSearch, resolveGoogleRuntime, runGogJson, type GoogleRuntime } from "../lib/google-transport.ts";
export { fetchPlaceDetails, fetchPlaceSearch, resolveGoogleRuntime, runGogJson } from "../lib/google-transport.ts";
import {
  MAX_EVENT_WINDOW_DAYS,
  MAX_AVAILABILITY_WINDOW_DAYS,
  MAX_GMAIL_THREADS,
  MAX_CONTACT_RESULTS,
  MAX_PLACE_CANDIDATES,
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
  parseGooglePlace,
  parseFirstGooglePlace,
  parseGooglePlaceCandidates,
  parseRichGooglePlace,
  normalizedPlacesLocale,
  parseAvailability,
  findConflicts
} from "../lib/google-operations.ts";

const PLACES_SEARCH_TTL_MS = 24 * 60 * 60 * 1_000;
const PLACES_CANDIDATES_TTL_MS = 24 * 60 * 60 * 1_000;
const PLACES_DETAILS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PLACES_RICH_DETAILS_TTL_MS = 1;

interface GoogleToolDetails {
  ok: boolean;
  result: unknown;
  error: { code: string; message: string } | null;
}

interface GoogleWorkspaceRegistrationOptions {
  resolveRuntime(): Promise<GoogleRuntime>;
  run(runtime: GoogleRuntime, args: string[], signal?: AbortSignal): Promise<unknown>;
  fetchPlaceDetails?: typeof fetchPlaceDetails;
  fetchPlaceSearch?: typeof fetchPlaceSearch;
  now?(): number;
}

interface PlacesFetchContext {
  apiKeyFile: string;
  locale: { language?: string; region?: string };
  signal?: AbortSignal;
  fetchPlaceDetails: typeof fetchPlaceDetails;
  fetchPlaceSearch: typeof fetchPlaceSearch;
}

// One entry per public Places operation and field profile. The cache profile
// and SKU strings are durable keys in google-places.db; changing them resets
// cached entries or monthly usage counts.
interface PlacesProfile {
  gatewayOperation: "search" | "details";
  cacheProfile: string;
  sku: string;
  ttlMs: number;
  cache: boolean;
  monthlyLimit(runtime: GoogleRuntime): number | undefined;
  cacheArguments(input: Record<string, unknown>): Record<string, string> | undefined;
  fetch(cacheArguments: Record<string, string>, context: PlacesFetchContext): Promise<unknown>;
  result(value: unknown): Record<string, unknown>;
}

function placesQuery(input: Record<string, unknown>): string | undefined {
  const query = requiredSafeString(input.query, 200)?.replace(/\s+/g, " ");
  return query && !query.startsWith("-") ? query : undefined;
}

function placesId(input: Record<string, unknown>): string | undefined {
  const placeId = requiredSafeString(input.place_id, 263)?.replace(/^places\//, "");
  return placeId && /^[A-Za-z0-9_-]+$/.test(placeId) ? placeId : undefined;
}

function localeOptions(context: PlacesFetchContext) {
  return {
    apiKeyFile: context.apiKeyFile,
    ...(context.locale.language ? { language: context.locale.language } : {}),
    ...(context.locale.region ? { region: context.locale.region } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

const PLACES_PROFILES = new Map<string, PlacesProfile>([
  ["places_search:identity", {
    gatewayOperation: "search",
    cacheProfile: "search_identity",
    sku: "places_text_search_basic",
    ttlMs: PLACES_SEARCH_TTL_MS,
    cache: true,
    monthlyLimit: (runtime) => runtime.placesSearchMonthlyLimit,
    cacheArguments: (input) => {
      const query = placesQuery(input);
      return query ? { query } : undefined;
    },
    fetch: async (args, context) => parseFirstGooglePlace(await context.fetchPlaceSearch({
      ...localeOptions(context), fields: "identity", query: args.query!, maxResults: 1,
    })),
    result: (place) => ({ fieldProfile: "identity", place }),
  }],
  ["places_search_candidates:", {
    gatewayOperation: "search",
    cacheProfile: "search_candidates",
    sku: "places_text_search_candidates",
    ttlMs: PLACES_CANDIDATES_TTL_MS,
    cache: true,
    monthlyLimit: (runtime) => runtime.placesCandidatesMonthlyLimit,
    cacheArguments: (input) => {
      const query = placesQuery(input);
      const limit = input.max_results === undefined ? MAX_PLACE_CANDIDATES : input.max_results;
      if (!query || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_PLACE_CANDIDATES) {
        return undefined;
      }
      return { query, maxResults: String(limit) };
    },
    fetch: async (args, context) => parseGooglePlaceCandidates(await context.fetchPlaceSearch({
      ...localeOptions(context), fields: "candidates", query: args.query!, maxResults: Number(args.maxResults),
    }), Number(args.maxResults)),
    result: (value) => {
      const candidates = value as { places: Array<Record<string, unknown>>; truncated: boolean };
      return {
        fieldProfile: "candidates",
        places: candidates.places,
        noResults: candidates.places.length === 0,
        truncated: candidates.truncated,
      };
    },
  }],
  ["places_details:identity", {
    gatewayOperation: "details",
    cacheProfile: "details_identity",
    sku: "places_details_basic",
    ttlMs: PLACES_DETAILS_TTL_MS,
    cache: true,
    monthlyLimit: (runtime) => runtime.placesDetailsMonthlyLimit,
    cacheArguments: (input) => {
      const placeId = placesId(input);
      return placeId ? { placeId } : undefined;
    },
    fetch: async (args, context) => parseGooglePlace(await context.fetchPlaceDetails({
      ...localeOptions(context), fields: "identity", placeId: args.placeId!,
    }), args.placeId!),
    result: (place) => ({ fieldProfile: "identity", place }),
  }],
  ["places_details:rich_details", {
    gatewayOperation: "details",
    cacheProfile: "details_rich_details",
    sku: "places_details_rich",
    ttlMs: PLACES_RICH_DETAILS_TTL_MS,
    cache: false,
    monthlyLimit: (runtime) => runtime.placesDetailsMonthlyLimit,
    cacheArguments: (input) => {
      const placeId = placesId(input);
      return placeId ? { placeId } : undefined;
    },
    fetch: async (args, context) => parseRichGooglePlace(await context.fetchPlaceDetails({
      ...localeOptions(context), fields: "rich", placeId: args.placeId!,
    }), args.placeId!),
    result: (place) => ({ fieldProfile: "rich_details", place }),
  }],
]);

interface MinimalPiApi {
  registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]): void;
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

export function registerGoogleWorkspaceTool(
  pi: MinimalPiApi,
  options: GoogleWorkspaceRegistrationOptions,
): void {
  pi.registerTool({
    name: "google_workspace",
    label: "Google Workspace",
    description:
      "Run typed, allowlisted Google operations for account status, bounded read-only Workspace inspection, and locally metered Google Places lookup.",
    promptSnippet: "Inspect configured Google Workspace data and perform bounded Google Places lookup",
    promptGuidelines: [
      "Use google_workspace only for its typed operations; never invoke gogcli through shell commands.",
      "Every operation is read-only. Never imply that an event, email, or contact was created, changed, sent, or accepted; proposed replies stay as text in your response.",
      "Use places_search_candidates for multi-place, comparison, or best/top-rated requests and choose which candidates to surface; the list is bounded and may be incomplete. Places requests may be blocked by a local monthly limit.",
      "Use rich_details only when ratings, hours, contact information, price, or reviews are requested. Attribute those results to Google Maps and keep review author/source links.",
    ],
    parameters: Type.Union([
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
      const account = selectedAccount(input, runtime);
      const isPlacesOperation =
        operation === "places_search" || operation === "places_search_candidates" || operation === "places_details";
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
        const fieldProfile = input.field_profile === undefined ? "" : input.field_profile;
        const profile = typeof fieldProfile === "string" ? PLACES_PROFILES.get(`${operation}:${fieldProfile}`) : undefined;
        const locale = normalizedPlacesLocale(input);
        const requestArguments = profile?.cacheArguments(input);
        if (!profile || !locale || !requestArguments) {
          return failure("GOOGLE_PLACES_INPUT_INVALID", "The Google Places request is invalid");
        }
        // Identity search and details limits enable Places as a group; each
        // profile additionally needs its own limit.
        const monthlyLimit = profile.monthlyLimit(runtime);
        if (
          !runtime.stateDir || !runtime.placesApiKeyFile || monthlyLimit === undefined ||
          runtime.placesSearchMonthlyLimit === undefined || runtime.placesDetailsMonthlyLimit === undefined
        ) {
          return failure("GOOGLE_PLACES_UNAVAILABLE", "Google Places is temporarily unavailable");
        }
        const context: PlacesFetchContext = {
          apiKeyFile: runtime.placesApiKeyFile,
          locale,
          ...(signal ? { signal } : {}),
          fetchPlaceDetails: options.fetchPlaceDetails ?? fetchPlaceDetails,
          fetchPlaceSearch: options.fetchPlaceSearch ?? fetchPlaceSearch,
        };
        try {
          const gateway = openGooglePlacesGateway(join(runtime.stateDir, "google-places.db"));
          try {
            const result = await gateway.request({
              operation: profile.gatewayOperation,
              profile: profile.cacheProfile,
              cacheArguments: { ...requestArguments, ...locale },
              sku: profile.sku,
              monthlyLimit,
              ttlMs: profile.ttlMs,
              now: options.now?.() ?? Date.now(),
              cache: profile.cache,
            }, () => profile.fetch(requestArguments, context));
            if (result.status === "blocked") {
              return success({ operation, blocked: true, reason: "monthly_limit" });
            }
            return success({ operation, cached: result.cached, ...profile.result(result.value) });
          } finally {
            gateway.close();
          }
        } catch {
          return failure("GOOGLE_PLACES_UNAVAILABLE", "Google Places is temporarily unavailable");
        }
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
          ...selectedCalendars,
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
      return await runGogJson({
        binary: runtime.binary!,
        passwordFile: runtime.passwordFile!,
        gogHome: runtime.gogHome!,
        args,
        ...(signal ? { signal } : {}),
      });
    },
  });
}
