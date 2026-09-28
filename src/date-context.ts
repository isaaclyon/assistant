import { casual, strict } from "chrono-node";
import type { ParsedComponents, ParsedResult } from "chrono-node";

export const DATE_TEXT_LIMIT = 16_384;
const MAX_RANGES = 8;
const DAY_MS = 86_400_000;

export interface DateRange {
  text: string;
  start: string;
  /** Inclusive calendar date, not an instant or a Calendar API end value. */
  end: string;
  interpretation?: string;
}

export interface DateContext {
  reference: string;
  timeZone: string;
  ranges: DateRange[];
  unresolved: string[];
}

interface LocatedRange extends DateRange { index: number }

function iso(date: Date): string { return date.toISOString().slice(0, 10); }
function plusDays(date: Date, days: number): Date { return new Date(date.getTime() + days * DAY_MS); }
function componentDate(components: ParsedComponents): string {
  return `${String(components.get("year")).padStart(4, "0")}-${String(components.get("month")).padStart(2, "0")}-${String(components.get("day")).padStart(2, "0")}`;
}

/** Represent the sender's calendar fields in UTC for interval arithmetic. */
function wallClock(sentAtMs: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(sentAtMs));
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")));
}

function mask(text: string): string {
  // Keep indices stable, including across newlines, for labels from the original.
  return text.replace(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s]+/g, (match) => " ".repeat(match.length))
    .replace(/[–—]/g, "-");
}

function parsedRange(result: ParsedResult): LocatedRange {
  return { index: result.index, text: result.text, start: componentDate(result.start),
    end: componentDate(result.end ?? result.start) };
}

/** Chrono's forwardDate also advances explicit 'last Friday' and dates earlier
 * today. Prefer future calendar dates only when the wording leaves it open. */
function preferUpcomingDate(range: LocatedRange, result: ParsedResult, today: Date): void {
  if (range.end >= iso(today) || /\b(last|past|ago|yesterday|before)\b/i.test(result.text)) return;
  if (result.start.isCertain("weekday") && !result.start.isCertain("day") &&
      !/\b(this|next)\b/i.test(result.text)) {
    range.start = iso(plusDays(new Date(`${range.start}T12:00:00Z`), 7));
    range.end = iso(plusDays(new Date(`${range.end}T12:00:00Z`), 7));
  } else if (result.start.isCertain("month") && !result.start.isCertain("year") &&
      !(result.end?.isCertain("year"))) {
    const start = new Date(`${range.start}T12:00:00Z`);
    const end = new Date(`${range.end}T12:00:00Z`);
    for (let years = 1; years <= 8; years += 1) {
      const nextStart = new Date(Date.UTC(start.getUTCFullYear() + years, start.getUTCMonth(), start.getUTCDate()));
      const nextEnd = new Date(Date.UTC(end.getUTCFullYear() + years, end.getUTCMonth(), end.getUTCDate()));
      // Preserve February 29 instead of silently normalizing it to March 1.
      if (nextStart.getUTCMonth() !== start.getUTCMonth() || nextEnd.getUTCMonth() !== end.getUTCMonth()) continue;
      if (iso(nextEnd) >= iso(today)) { range.start = iso(nextStart); range.end = iso(nextEnd); break; }
    }
  }
}

/** Local, bounded, English parsing. Hints are interpretations, never user edits. */
export function resolveDateContext(
  text: string,
  reference: { sentAtMs: number; timeZone: string },
): DateContext {
  const context: DateContext = { reference: "", timeZone: reference.timeZone, ranges: [], unresolved: [] };
  try {
    const wall = wallClock(reference.sentAtMs, reference.timeZone);
    context.reference = new Date(reference.sentAtMs).toISOString();
    const original = text.slice(0, DATE_TEXT_LIMIT);
    let input = mask(original);
    // Do not resolve a dependent fragment against today's date by accident.
    input = input.replace(/\b(?:(?:the\s+)?following\s+(?:weekend|week|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:the\s+)?weekend\s+(?:after|before)\s+(?:that|next)|(?:\d+|one|two|three|four|five|six|seven|a)\s+(?:days?|weeks?|months?)\s+(?:after|before)\s+(?:we|I|you|they|he|she|it|that|the)\b[^,.;!?\n]*)/gi,
      (match) => { if (context.unresolved.length < MAX_RANGES) context.unresolved.push(match.slice(0, 200)); return " ".repeat(match.length); });
    const located: LocatedRange[] = [];
    const today = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()));
    const monday = plusDays(today, -((today.getUTCDay() + 6) % 7));
    // Chrono maps weeks/months to a representative day. Supply actual intervals.
    input = input.replace(/\b(?:(this coming|this|next|last|upcoming|coming)\s+(weekend|week|month|year)|weekend)\b/gi, (text, modifier: string | undefined, unit: string | undefined, index: number) => {
      modifier = modifier?.toLowerCase() ?? "upcoming"; unit = unit?.toLowerCase() ?? "weekend";
      if (modifier === "this coming" || modifier === "coming") modifier = "upcoming";
      const shift = modifier === "last" ? -1 : modifier === "this" ? 0 : 1;
      let start: Date;
      let end: Date;
      let interpretation: string;
      if (unit === "weekend") {
        start = modifier === "next" || modifier === "upcoming"
          ? plusDays(today, ((5 - today.getUTCDay() + 7) % 7) || 7)
          : plusDays(monday, 4 + shift * 7);
        end = plusDays(start, 2);
        interpretation = "Friday–Sunday; next/upcoming means the first Friday strictly after the reference date; this means this calendar week's weekend";
      } else if (unit === "week") {
        start = plusDays(monday, shift * 7); end = plusDays(start, 6);
        interpretation = "Monday–Sunday calendar week";
      } else if (unit === "month") {
        start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + shift, 1));
        end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
        interpretation = "whole calendar month";
      } else {
        start = new Date(Date.UTC(today.getUTCFullYear() + shift, 0, 1));
        end = new Date(Date.UTC(start.getUTCFullYear(), 11, 31));
        interpretation = "whole calendar year";
      }
      located.push({ index, text, start: iso(start), end: iso(end), interpretation });
      return " ".repeat(text.length);
    });
    // Chrono's relative-date merge refiners drop explicit timezone overrides.
    // Give every parser/refiner the same wall-clock fields in its native local
    // Date representation; read calendar components only, never its instants.
    const parserReference = new Date(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(),
      wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds());
    for (const result of casual.parse(input, parserReference)) {
      if (result.start.isCertain("year") && result.start.isCertain("month") && !result.start.isCertain("day") && !result.end &&
          /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(result.text)) {
        located.push({ index: result.index, text: result.text,
          start: iso(new Date(Date.UTC(result.start.get("year")!, result.start.get("month")! - 1, 1))),
          end: iso(new Date(Date.UTC(result.start.get("year")!, result.start.get("month")!, 0))),
          interpretation: "whole named calendar month",
        });
        continue;
      }
      // Exclude bare clock times (and words such as 'May' with no date).
      if (!result.start.isCertain("day") && !result.start.isCertain("weekday") &&
          !/\b(today|tomorrow|yesterday|tonight|tmrw?|overmorrow|morning|afternoon|evening|night|days?|weeks?|months?|years?)\b/i.test(result.text)) continue;
      const range = parsedRange(result);
      preferUpcomingDate(range, result, today);
      if (range.end < range.start) continue;
      if (/\b(?:next|this|last)\s+(?:mon|tues?|wed|thurs?|fri|sat|sun)/i.test(result.text)) {
        range.interpretation = "weekday wording is ambiguous; Chrono's English interpretation, confirm if consequential";
      } else if (/\b\d{1,2}\/\d{1,2}\b/.test(result.text)) {
        range.interpretation = "English US month/day order; confirm if ambiguous";
      } else if (!result.start.isCertain("year") || result.start.isCertain("weekday")) {
        range.interpretation = "relative to the reference date; unqualified weekdays and omitted years prefer the upcoming occurrence";
      }
      located.push(range);
    }
    context.ranges = located.sort((a, b) => a.index - b.index).slice(0, MAX_RANGES)
      .map(({ index, ...range }) => ({ ...range, text: original.slice(index, index + range.text.length) }));
  } catch {
    // Malformed time context must never block the human turn or guess a date.
    context.ranges = []; context.unresolved = [];
  }
  return context;
}

/** Stored notes require explicit years: never reinterpret old 'next weekend'. */
export function extractAbsoluteDateRanges(text: string): Array<DateRange & { index: number }> {
  const input = mask(text.slice(0, DATE_TEXT_LIMIT));
  return strict.parse(input, { instant: new Date("2000-01-01T12:00:00Z"), timezone: 0 })
    .filter((result) => [result.start, result.end ?? result.start].every((part) =>
      part.isCertain("year") && part.isCertain("month") && part.isCertain("day")))
    .map(parsedRange).filter((range) => range.start <= range.end);
}

export function renderDateContext(context: DateContext): string {
  if (!context.ranges.length && !context.unresolved.length) return "";
  return [
    `Date context for this message (reference: ${context.reference}; timezone: ${context.timeZone}).`,
    "These are automatic date-only interpretations, with inclusive end dates. The original message is unchanged. Use its wording and conversation to resolve ambiguity; do not treat hints as a confirmed plan or permission to save memory.",
    ...context.ranges.map((range) => `${JSON.stringify(range.text)} → ${range.start}${range.end === range.start ? "" : ` through ${range.end}`}${range.interpretation ? ` (${range.interpretation})` : ""}`),
    ...context.unresolved.map((text) => `${JSON.stringify(text)} → unresolved; needs a date anchor from the conversation`),
  ].join("\n");
}
