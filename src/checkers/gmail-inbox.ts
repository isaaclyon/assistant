import { fileURLToPath } from "node:url";
import { readGmailInboxPage } from "../../.pi/lib/google-gmail-poll.js";
import { hasGogRuntime, resolveGoogleRuntime } from "../../.pi/lib/google-transport.js";
import type { JsonObject } from "../heartbeat.js";

interface GmailInboxArgs { account: string; timeZone: string }
type Search = (query: string, page?: string) => Promise<unknown>;
interface Cursor extends JsonObject { since: number; until?: number; page?: string; seen?: string[] }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_MESSAGES = 3;

function boundedText(value: string, maxJsonBytes: number): string {
  let result = value.slice(0, maxJsonBytes);
  while (Buffer.byteLength(JSON.stringify(result)) > maxJsonBytes) {
    result = result.slice(0, Math.floor(result.length * 0.9));
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGmailInboxArgs(raw: string | undefined): GmailInboxArgs {
  const value: unknown = JSON.parse(raw ?? "{}");
  if (!record(value) || typeof value.account !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9@._+-]{0,199}$/.test(value.account) ||
    typeof value.timeZone !== "string" || Object.keys(value).some((key) => !["account", "timeZone"].includes(key))) {
    throw new Error("Gmail checker requires account and timeZone");
  }
  new Intl.DateTimeFormat("en-CA", { timeZone: value.timeZone }).format();
  return { account: value.account, timeZone: value.timeZone };
}

function parseCursor(value: JsonObject): Cursor {
  if (!Number.isSafeInteger(value.since) || (value.since as number) < 0 ||
    (value.until !== undefined && (!Number.isSafeInteger(value.until) || (value.until as number) <= (value.since as number))) ||
    (value.page !== undefined && (typeof value.page !== "string" || !value.page || value.page.length > 2048)) ||
    (value.seen !== undefined && (!Array.isArray(value.seen) || value.seen.length > 1000 ||
      !value.seen.every((id) => typeof id === "string" && ID.test(id)))) ||
    ((value.page !== undefined) !== (value.until !== undefined))) {
    throw new Error("Invalid Gmail checker cursor");
  }
  return value as Cursor;
}

/** Cursor belongs to the host; this checker neither stores state nor judges mail. */
export async function observeGmailInbox(args: GmailInboxArgs, previous: JsonObject | null, search: Search, now = Date.now()) {
  const empty = (cursor: Cursor) => ({ version: 2 as const, value: { items: [] as JsonObject[] }, cursor });
  if (previous === null) return empty({ since: Math.floor(now / 1000) });
  const cursor = parseCursor(previous);
  // Leave time for Gmail search indexing. Fixed upper bounds keep new arrivals out of pagination.
  const until = cursor.until ?? Math.floor(now / 1000) - 120;
  if (until <= cursor.since) return empty(cursor);
  const payload = await search(`in:inbox after:${Math.max(0, cursor.since - 1)} before:${until}`, cursor.page);
  if (!record(payload) || !Array.isArray(payload.messages) || payload.messages.length > MAX_MESSAGES ||
    (payload.nextPageToken !== undefined && (typeof payload.nextPageToken !== "string" || payload.nextPageToken.length > 2048))) {
    throw new Error("Invalid Gmail message page");
  }
  const seen = new Set(cursor.seen ?? []);
  const items: JsonObject[] = [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: args.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  for (const message of payload.messages) {
    if (!record(message) || typeof message.id !== "string" || !ID.test(message.id) ||
      typeof message.threadId !== "string" || !ID.test(message.threadId) ||
      typeof message.internalDateIso !== "string" || !Number.isFinite(Date.parse(message.internalDateIso)) ||
      ["from", "subject", "body"].some((key) => message[key] !== undefined && typeof message[key] !== "string")) {
      throw new Error("Invalid Gmail message");
    }
    const delivered = Date.parse(message.internalDateIso) / 1000;
    if (delivered < cursor.since || delivered >= until || seen.has(message.id)) continue;
    seen.add(message.id);
    const body = (message.body as string | undefined) ?? "";
    const excerpt = boundedText(body, 4000);
    items.push({ id: message.id, threadId: message.threadId, account: args.account,
      receivedAt: message.internalDateIso, checkedAt: new Date(now).toISOString(), today, timeZone: args.timeZone,
      from: boundedText((message.from as string | undefined) ?? "", 500),
      subject: boundedText((message.subject as string | undefined) ?? "", 500),
      body: excerpt, truncated: excerpt.length < body.length, untrusted: true });
  }
  if (seen.size > 1000) throw new Error("Gmail polling window exceeds cursor capacity");
  const next = payload.nextPageToken as string | undefined;
  if (next && next === cursor.page) throw new Error("Gmail pagination did not advance");
  return { version: 2 as const, value: { items },
    cursor: next ? { since: cursor.since, until, page: next, seen: [...seen] } : { since: until } };
}

async function main(): Promise<void> {
  const args = parseGmailInboxArgs(process.argv[2]);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 40 * 1024) throw new Error("Checker input too large");
    chunks.push(Buffer.from(chunk));
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!record(input) || input.version !== 1 || (input.cursor !== null && !record(input.cursor))) {
    throw new Error("Gmail checker requires incremental mode");
  }
  const runtime = await resolveGoogleRuntime();
  if (!hasGogRuntime(runtime)) throw new Error("Google Workspace is not configured on the coordinator");
  const observation = await observeGmailInbox(args, input.cursor as JsonObject | null, (query, page) =>
    readGmailInboxPage(runtime, args.account, query, page));
  const output = JSON.stringify(observation);
  if (Buffer.byteLength(output) > 64 * 1024 || Buffer.byteLength(JSON.stringify(observation.cursor)) > 32 * 1024) {
    throw new Error("Gmail observation exceeds bounded output");
  }
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { process.stderr.write("Gmail inbox check failed\n"); process.exitCode = 1; });
}
