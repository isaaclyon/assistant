export const MAX_EVENT_WINDOW_DAYS = 366;
export const MAX_AVAILABILITY_WINDOW_DAYS = 31;
const MAX_BUSY_INTERVALS = 256;
const MAX_CALENDARS = 20;
export const MAX_GMAIL_THREADS = 50;
const MAX_GMAIL_MESSAGES = 50;
const MAX_GMAIL_MESSAGE_BODY_LENGTH = 8_000;
const MAX_GMAIL_THREAD_BODY_LENGTH = 32_000;
export const MAX_CONTACT_RESULTS = 10;
export const MAX_PLACE_CANDIDATES = 15;
const MAX_CONTACT_VALUES = 20;
const MAX_PLACE_REVIEWS = 3;
const FAILURE_MESSAGE = "Google Workspace command failed";

export function parseAccountStatus(payload: unknown, account: string, resolvedAccount = account): {
  operation: "account_status";
  account: string;
  authenticated: boolean;
  services: string[];
} {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { accounts?: unknown }).accounts)) {
    throw new Error(FAILURE_MESSAGE);
  }
  const match = (payload as { accounts: unknown[] }).accounts.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    return (candidate as { email?: unknown }).email?.toString().toLowerCase() === resolvedAccount.toLowerCase();
  });
  if (!match || typeof match !== "object") {
    return { operation: "account_status", account, authenticated: false, services: [] };
  }
  const services = Array.isArray((match as { services?: unknown }).services)
    ? (match as { services: unknown[] }).services
        .filter((service): service is string => typeof service === "string")
        .filter((service) => service.length <= 64)
        .sort()
        .slice(0, 32)
    : [];
  return { operation: "account_status", account, authenticated: true, services };
}

export function parseAccountAlias(payload: unknown, alias: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const aliases = (payload as { aliases?: unknown }).aliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return undefined;
  return requiredSafeString((aliases as Record<string, unknown>)[alias], 254);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, maxLength);
}

export function requiredSafeString(value: unknown, maxLength: number): string | undefined {
  const selected = boundedString(value, maxLength)?.trim();
  return selected && !/[\r\n\0]/.test(selected) ? selected : undefined;
}

export function selectedAccount(input: Record<string, unknown>, runtime: { account?: string }): string | undefined {
  return requiredSafeString(input.account, 254) ?? requiredSafeString(runtime.account, 254);
}

export function commonArgs(account: string): string[] {
  return [
    "--no-input",
    "--readonly",
    "--gmail-no-send",
    "--wrap-untrusted",
    "--json",
    "--account",
    account,
  ];
}

export function parseWindow(
  input: Record<string, unknown>,
  maxDays: number,
): { from: string; to: string } | undefined {
  const from = requiredSafeString(input.from, 64);
  const to = requiredSafeString(input.to, 64);
  if (!from || !to) return undefined;
  const accepted = /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))$/;
  if (!accepted.test(from) || !accepted.test(to)) return undefined;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return undefined;
  if (toMs - fromMs > maxDays * 24 * 60 * 60 * 1_000) return undefined;
  return { from, to };
}

export function maxResults(input: Record<string, unknown>, fallback: number): number | undefined {
  if (input.max_results === undefined) return fallback;
  return Number.isInteger(input.max_results) && Number(input.max_results) >= 1 && Number(input.max_results) <= 100
    ? Number(input.max_results)
    : undefined;
}

export function calendarIds(input: Record<string, unknown>): string[] | undefined {
  if (input.calendar_ids === undefined) return ["primary"];
  if (!Array.isArray(input.calendar_ids) || input.calendar_ids.length < 1 || input.calendar_ids.length > 20) {
    return undefined;
  }
  const selected = input.calendar_ids.map((value) => requiredSafeString(value, 1_024));
  return selected.every((value): value is string => typeof value === "string" && !value.startsWith("-"))
    ? [...new Set(selected)]
    : undefined;
}

export function parseCalendars(payload: unknown, account: string): {
  operation: "calendar_list";
  account: string;
  calendars: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { calendars?: unknown }).calendars)) {
    throw new Error(FAILURE_MESSAGE);
  }
  const calendars = (payload as { calendars: unknown[] }).calendars.slice(0, 100).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const id = boundedString(item.id, 1_024);
    if (!id) return [];
    const normalized: Record<string, unknown> = { id };
    const summary = boundedString(item.summary, 500);
    const timeZone = boundedString(item.timeZone, 64);
    const accessRole = boundedString(item.accessRole, 32);
    if (summary) normalized.summary = summary;
    if (timeZone) normalized.timeZone = timeZone;
    if (typeof item.primary === "boolean") normalized.primary = item.primary;
    if (typeof item.selected === "boolean") normalized.selected = item.selected;
    if (accessRole) normalized.accessRole = accessRole;
    normalized.untrusted = true;
    return [normalized];
  });
  return {
    operation: "calendar_list",
    account,
    calendars,
    truncated:
      (payload as { calendars: unknown[] }).calendars.length > 100 ||
      Boolean(boundedString((payload as { nextPageToken?: unknown }).nextPageToken, 2_048)),
  };
}

export function parseEvents(
  payload: unknown,
  operation: "calendar_events" | "calendar_search",
  account: string,
  limit: number,
  query?: string,
): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { events?: unknown }).events)) {
    throw new Error(FAILURE_MESSAGE);
  }
  const rawEvents = (payload as { events: unknown[] }).events;
  const events = rawEvents.slice(0, limit).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (item.status === "cancelled") return [];
    const startObject = item.start && typeof item.start === "object" ? item.start as Record<string, unknown> : {};
    const endObject = item.end && typeof item.end === "object" ? item.end as Record<string, unknown> : {};
    const allDay = typeof startObject.date === "string";
    const start = boundedString(item.startLocal, 64) ?? boundedString(allDay ? startObject.date : startObject.dateTime, 64);
    const end = boundedString(item.endLocal, 64) ?? boundedString(allDay ? endObject.date : endObject.dateTime, 64);
    const id = boundedString(item.id, 1_024);
    if (!id || !start || !end) return [];
    const normalized: Record<string, unknown> = { id };
    const calendarId = boundedString(item.calendarId, 1_024);
    const status = boundedString(item.status, 32);
    const summary = boundedString(item.summary, 500);
    const description = boundedString(item.description, 2_000);
    const location = boundedString(item.location, 500);
    const timeZone = boundedString(item.timezone, 64) ?? boundedString(startObject.timeZone, 64);
    const recurringEventId = boundedString(item.recurringEventId, 1_024);
    if (calendarId) normalized.calendarId = calendarId;
    if (status) normalized.status = status;
    if (summary) normalized.summary = summary;
    if (description) normalized.description = description;
    if (location) normalized.location = location;
    normalized.start = start;
    normalized.end = end;
    normalized.allDay = allDay;
    if (timeZone) normalized.timeZone = timeZone;
    if (recurringEventId) normalized.recurringEventId = recurringEventId;
    normalized.untrusted = true;
    return [normalized];
  });
  return {
    operation,
    account,
    ...(query ? { query } : {}),
    events,
    truncated:
      rawEvents.length > limit ||
      Boolean(boundedString((payload as { nextPageToken?: unknown }).nextPageToken, 2_048)) ||
      Boolean(
        (payload as { nextPageTokens?: unknown }).nextPageTokens &&
        typeof (payload as { nextPageTokens?: unknown }).nextPageTokens === "object" &&
        Object.keys((payload as { nextPageTokens: object }).nextPageTokens).length > 0,
      ),
  };
}

export function parseGmailSearch(
  payload: unknown,
  account: string,
  query: string,
  limit: number,
): {
  operation: "gmail_search";
  account: string;
  query: string;
  threads: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { threads?: unknown }).threads)) {
    throw new Error(FAILURE_MESSAGE);
  }
  const rawThreads = (payload as { threads: unknown[] }).threads;
  let malformed = false;
  const threads = rawThreads.slice(0, Math.min(limit, MAX_GMAIL_THREADS)).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      malformed = true;
      return [];
    }
    const item = candidate as Record<string, unknown>;
    const id = requiredSafeString(item.id, 256);
    if (!id || id.startsWith("-")) {
      malformed = true;
      return [];
    }
    const normalized: Record<string, unknown> = { id };
    const date = boundedString(item.date, 128);
    const from = boundedString(item.from, 500);
    const subject = boundedString(item.subject, 500);
    if (date) normalized.date = date;
    if (from) normalized.from = from;
    if (subject) normalized.subject = subject;
    if (Array.isArray(item.labels)) {
      normalized.labels = item.labels
        .filter((label): label is string => typeof label === "string" && label.length > 0)
        .map((label) => label.slice(0, 100))
        .slice(0, 50);
    }
    if (Number.isInteger(item.messageCount) && Number(item.messageCount) >= 0) {
      normalized.messageCount = Math.min(Number(item.messageCount), 10_000);
    }
    normalized.untrusted = true;
    return [normalized];
  });
  return {
    operation: "gmail_search",
    account,
    query,
    threads,
    truncated:
      malformed ||
      rawThreads.length > limit ||
      rawThreads.length > MAX_GMAIL_THREADS ||
      Boolean(boundedString((payload as { nextPageToken?: unknown }).nextPageToken, 2_048)),
  };
}

function parseGmailAttachments(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const filename = boundedString(item.filename, 500);
    if (!filename) return [];
    const attachment: Record<string, unknown> = { filename };
    const mimeType = boundedString(item.mimeType, 200);
    if (mimeType) attachment.mimeType = mimeType;
    if (Number.isInteger(item.size) && Number(item.size) >= 0) attachment.size = Number(item.size);
    return [attachment];
  });
}

export function parseGmailThread(payload: unknown, account: string, expectedThreadId: string): {
  operation: "gmail_thread";
  account: string;
  thread: Record<string, unknown>;
} {
  if (!payload || typeof payload !== "object") throw new Error(FAILURE_MESSAGE);
  const rawThread = (payload as { thread?: unknown }).thread;
  if (!rawThread || typeof rawThread !== "object" || Array.isArray(rawThread)) throw new Error(FAILURE_MESSAGE);
  const thread = rawThread as Record<string, unknown>;
  const id = requiredSafeString(thread.id, 256);
  if (id !== expectedThreadId || !Array.isArray(thread.messages)) throw new Error(FAILURE_MESSAGE);

  let remainingBodyLength = MAX_GMAIL_THREAD_BODY_LENGTH;
  let truncated = thread.messages.length > MAX_GMAIL_MESSAGES;
  const messages = thread.messages.slice(0, MAX_GMAIL_MESSAGES).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      truncated = true;
      return [];
    }
    const item = candidate as Record<string, unknown>;
    const messageId = requiredSafeString(item.id, 256);
    const threadId = requiredSafeString(item.threadId, 256);
    if (!messageId || messageId.startsWith("-") || threadId !== id) {
      truncated = true;
      return [];
    }
    const normalized: Record<string, unknown> = { id: messageId, threadId };
    if (Array.isArray(item.labelIds)) {
      normalized.labels = item.labelIds
        .filter((label): label is string => typeof label === "string" && label.length > 0)
        .map((label) => label.slice(0, 100))
        .slice(0, 50);
    }
    const headers = item.headers && typeof item.headers === "object" && !Array.isArray(item.headers)
      ? item.headers as Record<string, unknown>
      : {};
    for (const [source, target, maximum] of [
      ["from", "from", 500], ["to", "to", 500], ["cc", "cc", 500],
      ["subject", "subject", 500], ["date", "date", 128],
    ] as const) {
      const selected = boundedString(headers[source], maximum);
      if (selected) normalized[target] = selected;
    }
    const snippet = boundedString(item.snippet, 500);
    if (snippet) normalized.snippet = snippet;
    if (typeof item.body === "string" && item.body.length > 0) {
      const retainedLength = Math.min(item.body.length, MAX_GMAIL_MESSAGE_BODY_LENGTH, remainingBodyLength);
      if (retainedLength > 0) normalized.body = item.body.slice(0, retainedLength);
      if (retainedLength < item.body.length) truncated = true;
      remainingBodyLength -= retainedLength;
    }
    const attachments = parseGmailAttachments(item.attachments);
    if (attachments.length > 0) normalized.attachments = attachments;
    if (Array.isArray(item.attachments)) {
      normalized.attachmentCount = item.attachments.length;
      if (item.attachments.length > attachments.length) truncated = true;
    }
    normalized.untrusted = true;
    return [normalized];
  });
  return {
    operation: "gmail_thread",
    account,
    thread: { id, messages, truncated, untrusted: true },
  };
}

function normalizePhoneNumber(value: string): string | undefined {
  const input = value.trim();
  if (!/^[+0-9\s().-]+$/.test(input)) return undefined;
  if (input.includes("+") && !input.startsWith("+")) return undefined;
  if ((input.match(/\+/g) ?? []).length > 1) return undefined;
  const open = input.indexOf("(");
  const close = input.indexOf(")");
  if ((open === -1) !== (close === -1)) return undefined;
  if (open !== -1) {
    if (input.indexOf("(", open + 1) !== -1 || input.indexOf(")", close + 1) !== -1) return undefined;
    if (close < open || !/^\d{2,4}$/.test(input.slice(open + 1, close))) return undefined;
    if (!/^\+?\d{0,3}\s?$/.test(input.slice(0, open))) return undefined;
    if (close + 1 < input.length && !/[\s.-]/.test(input[close + 1]!)) return undefined;
  }
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === "." || input[index] === "-") {
      if (!/\d/.test(input[index - 1] ?? "") || !/\d/.test(input[index + 1] ?? "")) return undefined;
    }
  }
  const normalized = input.replace(/[\s().-]/g, "");
  return /^\+?[1-9][0-9]{6,14}$/.test(normalized) ? normalized : undefined;
}

function contactValue(value: unknown, maxLength: number): { output: string; raw: string } | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const wrapped = value.match(
    /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]{16})">>>\nSource: google_api\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/,
  );
  if (wrapped) {
    const raw = boundedString(wrapped[2], maxLength);
    return raw && raw.length === wrapped[2]!.length ? { output: value, raw } : undefined;
  }
  const raw = boundedString(value, maxLength);
  return raw ? { output: raw, raw } : undefined;
}

export function parseContactSearchResources(payload: unknown, limit: number): {
  resources: string[];
  truncated: boolean;
} {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { contacts?: unknown }).contacts)) {
    throw new Error(FAILURE_MESSAGE);
  }
  const rawContacts = (payload as { contacts: unknown[] }).contacts;
  let malformed = false;
  const resources: string[] = [];
  for (const candidate of rawContacts.slice(0, limit)) {
    if (!candidate || typeof candidate !== "object") {
      malformed = true;
      continue;
    }
    const resource = requiredSafeString((candidate as Record<string, unknown>).resource, 256);
    if (!resource?.startsWith("people/") || resource.length === "people/".length) {
      malformed = true;
      continue;
    }
    if (!resources.includes(resource)) resources.push(resource);
  }
  return {
    resources,
    truncated: malformed || rawContacts.length >= limit || resources.length < Math.min(rawContacts.length, limit),
  };
}

function primaryContactName(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((candidate): candidate is Record<string, unknown> =>
    Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate));
  const primary = names.find((candidate) => {
    const metadata = candidate.metadata;
    return Boolean(metadata) && typeof metadata === "object" && !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).primary === true;
  });
  return boundedString((primary ?? names[0])?.displayName, 500);
}

function contactValues(value: unknown, kind: "email" | "phone"): {
  values: Array<Record<string, string>>;
  truncated: boolean;
} {
  if (!Array.isArray(value)) return { values: [], truncated: false };
  let malformed = false;
  const values = value.slice(0, MAX_CONTACT_VALUES).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      malformed = true;
      return [];
    }
    const item = candidate as Record<string, unknown>;
    const selected = contactValue(item.value, kind === "email" ? 320 : 64);
    if (!selected) {
      malformed = true;
      return [];
    }
    const normalized: Record<string, string> = { value: selected.output };
    const label = boundedString(item.formattedType, 80) ?? boundedString(item.type, 80);
    if (label) normalized.label = label;
    if (kind === "phone") {
      const phone = normalizePhoneNumber(selected.raw);
      if (phone) normalized.normalized = phone;
    }
    return [normalized];
  });
  return { values, truncated: malformed || value.length > MAX_CONTACT_VALUES };
}

export function parseContact(payload: unknown, expectedResource: string): {
  contact: Record<string, unknown>;
  truncated: boolean;
} {
  if (!payload || typeof payload !== "object") throw new Error(FAILURE_MESSAGE);
  const rawContact = (payload as { contact?: unknown }).contact;
  if (!rawContact || typeof rawContact !== "object" || Array.isArray(rawContact)) throw new Error(FAILURE_MESSAGE);
  const item = rawContact as Record<string, unknown>;
  const resource = requiredSafeString(item.resourceName, 256);
  if (resource !== expectedResource) throw new Error(FAILURE_MESSAGE);
  const emails = contactValues(item.emailAddresses, "email");
  const phones = contactValues(item.phoneNumbers, "phone");
  const contact: Record<string, unknown> = {
    resource,
    emails: emails.values,
    phones: phones.values,
    untrusted: true,
  };
  const displayName = primaryContactName(item.names);
  if (displayName) contact.displayName = displayName;
  return { contact, truncated: emails.truncated || phones.truncated };
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

export function parseGooglePlaceCandidates(payload: unknown, limit: number): {
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

export function parseGooglePlace(payload: unknown, expectedPlaceId: string): Record<string, unknown> {
  const place = parseGooglePlaceCandidate(payload);
  if (!place || place.id !== expectedPlaceId) throw new Error(FAILURE_MESSAGE);
  return place;
}

export function parseFirstGooglePlace(payload: unknown): Record<string, unknown> {
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

export function parseRichGooglePlace(payload: unknown, expectedPlaceId: string): Record<string, unknown> {
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

export function normalizedPlacesLocale(input: Record<string, unknown>): {
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

interface BusyInterval {
  start: string;
  end: string;
}

export function parseAvailability(payload: unknown, account: string): {
  account: string;
  calendars: Array<{ id: string; busy: BusyInterval[] }>;
  truncated: boolean;
} {
  if (!payload || typeof payload !== "object") throw new Error(FAILURE_MESSAGE);
  const rawCalendars = (payload as { calendars?: unknown }).calendars;
  if (!rawCalendars || typeof rawCalendars !== "object" || Array.isArray(rawCalendars)) {
    throw new Error(FAILURE_MESSAGE);
  }
  let retained = 0;
  let truncated = false;
  const calendars: Array<{ id: string; busy: BusyInterval[] }> = [];
  const rawEntries = Object.entries(rawCalendars);
  if (rawEntries.length > MAX_CALENDARS) truncated = true;
  for (const [rawId, rawCalendar] of rawEntries.slice(0, MAX_CALENDARS)) {
    if (retained >= MAX_BUSY_INTERVALS) {
      truncated = true;
      break;
    }
    if (!rawCalendar || typeof rawCalendar !== "object") continue;
    const id = boundedString(rawId, 1_024);
    const errors = (rawCalendar as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) throw new Error(FAILURE_MESSAGE);
    const rawBusy = (rawCalendar as { busy?: unknown }).busy;
    if (!id || !Array.isArray(rawBusy)) throw new Error(FAILURE_MESSAGE);
    const busy: BusyInterval[] = [];
    for (const candidate of rawBusy) {
      if (retained >= MAX_BUSY_INTERVALS) {
        truncated = true;
        break;
      }
      if (!candidate || typeof candidate !== "object") throw new Error(FAILURE_MESSAGE);
      const start = boundedString((candidate as { start?: unknown }).start, 64);
      const end = boundedString((candidate as { end?: unknown }).end, 64);
      if (
        !start ||
        !end ||
        !Number.isFinite(Date.parse(start)) ||
        !Number.isFinite(Date.parse(end)) ||
        Date.parse(end) <= Date.parse(start)
      ) {
        throw new Error(FAILURE_MESSAGE);
      }
      busy.push({ start, end });
      retained += 1;
    }
    calendars.push({ id, busy });
  }
  return { account, calendars, truncated };
}

export function findConflicts(
  availability: Array<{ account: string; calendars: Array<{ busy: BusyInterval[] }> }>,
): {
  conflicts: Array<{ start: string; end: string; accounts: string[] }>;
  truncated: boolean;
} {
  const conflicts = new Map<string, { start: string; end: string; accounts: string[] }>();
  for (let leftIndex = 0; leftIndex < availability.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < availability.length; rightIndex += 1) {
      const left = availability[leftIndex]!;
      const right = availability[rightIndex]!;
      const leftBusy = left.calendars.flatMap((calendar) => calendar.busy);
      const rightBusy = right.calendars.flatMap((calendar) => calendar.busy);
      for (const first of leftBusy) {
        for (const second of rightBusy) {
          const startMs = Math.max(Date.parse(first.start), Date.parse(second.start));
          const endMs = Math.min(Date.parse(first.end), Date.parse(second.end));
          if (startMs >= endMs) continue;
          const conflict = {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            accounts: [left.account, right.account],
          };
          conflicts.set(`${conflict.start}\0${conflict.end}\0${conflict.accounts.join("\0")}`, conflict);
          if (conflicts.size >= MAX_BUSY_INTERVALS) {
            return { conflicts: [...conflicts.values()], truncated: true };
          }
        }
      }
    }
  }
  return {
    conflicts: [...conflicts.values()].sort((left, right) => left.start.localeCompare(right.start)),
    truncated: false,
  };
}
