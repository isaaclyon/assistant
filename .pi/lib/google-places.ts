// Google Places (API-key billing) is independent of the gog/OAuth Workspace
// path: it never needs gog configuration. Everything a Places request touches
// lives here: public profiles, cache/meter keys, fixed HTTPS field masks, and
// response normalization. See ADR-0029.
import { join } from "node:path";
import { openGooglePlacesGateway } from "../../src/google-places-gateway.ts";
import { boundedString, requiredSafeString } from "./google-operations.ts";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  FAILURE_MESSAGE,
  readBoundedResponse,
  readPrivatePassword,
  type GoogleRuntime,
} from "./google-transport.ts";

export const MAX_PLACE_CANDIDATES = 15;
const MAX_PLACE_REVIEWS = 3;
const PLACES_SEARCH_TTL_MS = 24 * 60 * 60 * 1_000;
const PLACES_CANDIDATES_TTL_MS = 24 * 60 * 60 * 1_000;
const PLACES_DETAILS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PLACES_RICH_DETAILS_TTL_MS = 1;

export const PLACES_OPERATIONS = new Set(["places_search", "places_search_candidates", "places_details"]);

const IDENTITY_PLACE_FIELDS = ["id", "displayName", "formattedAddress", "googleMapsUri"];
const SEARCH_FIELD_MASKS = {
  identity: IDENTITY_PLACE_FIELDS,
  candidates: [...IDENTITY_PLACE_FIELDS, "rating", "userRatingCount"],
} as const;
const DETAILS_FIELD_MASKS = {
  identity: IDENTITY_PLACE_FIELDS,
  rich: [
    ...IDENTITY_PLACE_FIELDS, "rating", "userRatingCount", "regularOpeningHours",
    "nationalPhoneNumber", "websiteUri", "priceLevel", "reviews.rating", "reviews.text",
    "reviews.originalText", "reviews.publishTime", "reviews.relativePublishTimeDescription",
    "reviews.authorAttribution", "reviews.googleMapsUri", "reviews.visitDate",
  ],
} as const;

export type PlaceSearchFields = keyof typeof SEARCH_FIELD_MASKS;
export type PlaceDetailsFields = keyof typeof DETAILS_FIELD_MASKS;

async function fetchPlacesJson(options: {
  apiKeyFile: string;
  signal?: AbortSignal;
}, prepare: () => { url: URL; fieldMask: string; body?: Record<string, unknown> }): Promise<unknown> {
  try {
    if (options.signal?.aborted) throw new Error(FAILURE_MESSAGE);
    const request = prepare();
    const apiKey = await readPrivatePassword(options.apiKeyFile);
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    if (signal.aborted) throw new Error(FAILURE_MESSAGE);
    const response = await fetch(request.url, {
      ...(request.body ? { method: "POST", body: JSON.stringify(request.body) } : {}),
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": request.fieldMask,
        ...(request.body ? { "Content-Type": "application/json" } : {}),
      },
      signal,
    });
    if (!response.ok) throw new Error(FAILURE_MESSAGE);
    const body = await readBoundedResponse(response, DEFAULT_MAX_OUTPUT_BYTES);
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }
}

export async function fetchPlaceDetails(options: {
  apiKeyFile: string;
  fields: PlaceDetailsFields;
  placeId: string;
  language?: string;
  region?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  return fetchPlacesJson(options, () => {
    const fields = Object.hasOwn(DETAILS_FIELD_MASKS, options.fields) ? DETAILS_FIELD_MASKS[options.fields] : undefined;
    if (!fields) throw new Error(FAILURE_MESSAGE);
    const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(options.placeId)}`);
    if (options.language) url.searchParams.set("languageCode", options.language);
    if (options.region) url.searchParams.set("regionCode", options.region);
    return { url, fieldMask: fields.join(",") };
  });
}

export async function fetchPlaceSearch(options: {
  apiKeyFile: string;
  fields: PlaceSearchFields;
  query: string;
  maxResults: number;
  language?: string;
  region?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  return fetchPlacesJson(options, () => {
    const fields = Object.hasOwn(SEARCH_FIELD_MASKS, options.fields) ? SEARCH_FIELD_MASKS[options.fields] : undefined;
    if (
      !fields || !Number.isInteger(options.maxResults) ||
      options.maxResults < 1 || options.maxResults > MAX_PLACE_CANDIDATES
    ) {
      throw new Error(FAILURE_MESSAGE);
    }
    return {
      url: new URL("https://places.googleapis.com/v1/places:searchText"),
      fieldMask: fields.map((field) => `places.${field}`).join(","),
      body: {
        textQuery: options.query,
        pageSize: options.maxResults,
        ...(options.language ? { languageCode: options.language } : {}),
        ...(options.region ? { regionCode: options.region } : {}),
      },
    };
  });
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


export interface PlacesOperationOptions {
  fetchPlaceDetails?: typeof fetchPlaceDetails;
  fetchPlaceSearch?: typeof fetchPlaceSearch;
  now?(): number;
}

export type PlacesOperationResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: "GOOGLE_PLACES_INPUT_INVALID" | "GOOGLE_PLACES_UNAVAILABLE"; message: string };

export async function executePlacesOperation(
  operation: string,
  input: Record<string, unknown>,
  runtime: GoogleRuntime,
  options: PlacesOperationOptions,
  signal?: AbortSignal,
): Promise<PlacesOperationResult> {
  const unavailable = { ok: false, code: "GOOGLE_PLACES_UNAVAILABLE", message: "Google Places is temporarily unavailable" } as const;
  const fieldProfile = input.field_profile === undefined ? "" : input.field_profile;
  const profile = typeof fieldProfile === "string" ? PLACES_PROFILES.get(`${operation}:${fieldProfile}`) : undefined;
  const locale = normalizedPlacesLocale(input);
  const requestArguments = profile?.cacheArguments(input);
  if (!profile || !locale || !requestArguments) {
    return { ok: false, code: "GOOGLE_PLACES_INPUT_INVALID", message: "The Google Places request is invalid" };
  }
  // Identity search and details limits enable Places as a group; each
  // profile additionally needs its own limit.
  const monthlyLimit = profile.monthlyLimit(runtime);
  if (
    !runtime.stateDir || !runtime.placesApiKeyFile || monthlyLimit === undefined ||
    runtime.placesSearchMonthlyLimit === undefined || runtime.placesDetailsMonthlyLimit === undefined
  ) {
    return unavailable;
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
        return { ok: true, result: { operation, blocked: true, reason: "monthly_limit" } };
      }
      return { ok: true, result: { operation, cached: result.cached, ...profile.result(result.value) } };
    } finally {
      gateway.close();
    }
  } catch {
    return unavailable;
  }
}

function parseGooglePlaceCandidate(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = requiredSafeString(item.id, 256);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const place: Record<string, unknown> = { id, source: "Google Maps", untrusted: true };
  const displayName = localizedText(item.displayName, 500);
  if (displayName) place.displayName = displayName.text;
  const formattedAddress = boundedString(item.formattedAddress, 1_000);
  if (formattedAddress) place.formattedAddress = formattedAddress;
  const googleMapsUri = safeHttpsUrl(item.googleMapsUri);
  if (googleMapsUri) place.googleMapsUri = googleMapsUri;
  if (typeof item.rating === "number" && Number.isFinite(item.rating) && item.rating >= 0 && item.rating <= 5) {
    place.rating = item.rating;
  }
  if (Number.isSafeInteger(item.userRatingCount) && (item.userRatingCount as number) >= 0) {
    place.userRatingCount = item.userRatingCount;
  }
  return place;
}

function parseGooglePlaceCandidates(payload: unknown, limit: number): {
  places: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(FAILURE_MESSAGE);
  const item = payload as Record<string, unknown>;
  if (item.places === undefined) {
    return {
      places: [],
      truncated: Boolean(requiredSafeString(item.nextPageToken, 2_048)),
    };
  }
  if (!Array.isArray(item.places)) throw new Error(FAILURE_MESSAGE);
  const places: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const value of item.places) {
    if (places.length >= limit) break;
    const place = parseGooglePlaceCandidate(value);
    const id = typeof place?.id === "string" ? place.id : undefined;
    if (!place || !id || seen.has(id)) continue;
    seen.add(id);
    places.push(place);
  }
  return {
    places,
    truncated: item.places.length > limit || Boolean(requiredSafeString(item.nextPageToken, 2_048)),
  };
}

function parseGooglePlace(payload: unknown, expectedPlaceId: string): Record<string, unknown> {
  const place = parseGooglePlaceCandidate(payload);
  if (!place || place.id !== expectedPlaceId) throw new Error(FAILURE_MESSAGE);
  return place;
}

function parseFirstGooglePlace(payload: unknown): Record<string, unknown> {
  const [place] = parseGooglePlaceCandidates(payload, 1).places;
  if (!place) throw new Error(FAILURE_MESSAGE);
  return place;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const candidate = requiredSafeString(value, 2_048);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function localizedText(value: unknown, maxLength: number): { text: string; languageCode?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const text = boundedString(item.text, maxLength);
  if (!text) return undefined;
  const languageCode = requiredSafeString(item.languageCode, 35);
  return { text, ...(languageCode ? { languageCode } : {}) };
}

function parseRichGooglePlace(payload: unknown, expectedPlaceId: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(FAILURE_MESSAGE);
  const item = payload as Record<string, unknown>;
  const id = requiredSafeString(item.id, 256);
  if (!id || id !== expectedPlaceId) throw new Error(FAILURE_MESSAGE);
  const place: Record<string, unknown> = { id, untrusted: true, source: "Google Maps" };
  const displayName = localizedText(item.displayName, 500);
  if (displayName) place.displayName = displayName.text;
  const formattedAddress = boundedString(item.formattedAddress, 1_000);
  if (formattedAddress) place.formattedAddress = formattedAddress;
  const googleMapsUri = safeHttpsUrl(item.googleMapsUri);
  if (googleMapsUri) place.googleMapsUri = googleMapsUri;
  if (typeof item.rating === "number" && item.rating >= 0 && item.rating <= 5) place.rating = item.rating;
  if (Number.isSafeInteger(item.userRatingCount) && (item.userRatingCount as number) >= 0) {
    place.userRatingCount = item.userRatingCount;
  }
  const phone = boundedString(item.nationalPhoneNumber, 100);
  if (phone) place.nationalPhoneNumber = phone;
  const websiteUri = safeHttpsUrl(item.websiteUri);
  if (websiteUri) place.websiteUri = websiteUri;
  const priceLevel = requiredSafeString(item.priceLevel, 64);
  if (priceLevel && /^PRICE_LEVEL_[A-Z_]+$/.test(priceLevel)) place.priceLevel = priceLevel;
  const hours = item.regularOpeningHours;
  if (hours && typeof hours === "object" && !Array.isArray(hours)) {
    const descriptions = (hours as Record<string, unknown>).weekdayDescriptions;
    if (Array.isArray(descriptions)) {
      place.weekdayDescriptions = descriptions
        .slice(0, 7)
        .map((value) => boundedString(value, 200))
        .filter((value): value is string => Boolean(value));
    }
  }
  if (Array.isArray(item.reviews)) {
    place.reviews = item.reviews.slice(0, MAX_PLACE_REVIEWS).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const review = value as Record<string, unknown>;
      const normalized: Record<string, unknown> = { untrusted: true };
      if (typeof review.rating === "number" && review.rating >= 0 && review.rating <= 5) normalized.rating = review.rating;
      const text = localizedText(review.text, 1_500);
      if (text) normalized.text = text;
      const originalText = localizedText(review.originalText, 1_500);
      if (originalText) normalized.originalText = originalText;
      const published = requiredSafeString(review.publishTime, 64);
      if (published) normalized.publishTime = published;
      const relative = boundedString(review.relativePublishTimeDescription, 100);
      if (relative) normalized.relativePublishTimeDescription = relative;
      const reviewUri = safeHttpsUrl(review.googleMapsUri);
      const author = review.authorAttribution;
      if (author && typeof author === "object" && !Array.isArray(author)) {
        const authorItem = author as Record<string, unknown>;
        const displayName = boundedString(authorItem.displayName, 200);
        const uri = safeHttpsUrl(authorItem.uri);
        if (displayName && uri && reviewUri) {
          normalized.authorAttribution = { displayName, uri };
          normalized.googleMapsUri = reviewUri;
        }
      }
      const visitDate = review.visitDate;
      if (visitDate && typeof visitDate === "object" && !Array.isArray(visitDate)) {
        const date = visitDate as Record<string, unknown>;
        if (Number.isInteger(date.year) && (date.year as number) >= 1 && (date.year as number) <= 9999 &&
            Number.isInteger(date.month) && (date.month as number) >= 1 && (date.month as number) <= 12) {
          normalized.visitDate = { year: date.year, month: date.month };
        }
      }
      return normalized.authorAttribution && normalized.googleMapsUri ? [normalized] : [];
    });
  }
  return place;
}

function normalizedPlacesLocale(input: Record<string, unknown>): {
  language?: string;
  region?: string;
} | undefined {
  const rawLanguage = input.language === undefined ? undefined : requiredSafeString(input.language, 35);
  const rawRegion = input.region === undefined ? undefined : requiredSafeString(input.region, 2);
  if (
    (input.language !== undefined && (!rawLanguage || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(rawLanguage))) ||
    (input.region !== undefined && (!rawRegion || !/^[A-Za-z]{2}$/.test(rawRegion)))
  ) {
    return undefined;
  }
  return {
    ...(rawLanguage ? { language: rawLanguage.toLowerCase() } : {}),
    ...(rawRegion ? { region: rawRegion.toUpperCase() } : {}),
  };
}
