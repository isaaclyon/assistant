import { describe, expect, it } from "vitest";
import { resolveDateContext, extractAbsoluteDateRanges } from "../src/date-context.js";
import { bindDateContextHandoff, createDateContextHandoff, takePreparedDateContext } from "../src/date-context-runtime.js";

const reference = { sentAtMs: Date.parse("2026-09-28T05:12:17Z"), timeZone: "America/Denver" };
const dates = (text: string, ref = reference) => resolveDateContext(text, ref).ranges;

describe("natural-language date context", () => {
  it.each([
    ["next weekend", "2026-10-02", "2026-10-04"],
    ["this weekend", "2026-09-25", "2026-09-27"],
    ["last weekend", "2026-09-18", "2026-09-20"],
    ["this coming weekend", "2026-10-02", "2026-10-04"],
    ["weekend", "2026-10-02", "2026-10-04"],
    ["tomorrow", "2026-09-28", "2026-09-28"],
    ["yesterday", "2026-09-26", "2026-09-26"],
    ["next week", "2026-09-28", "2026-10-04"],
    ["next month", "2026-10-01", "2026-10-31"],
    ["October 2026", "2026-10-01", "2026-10-31"],
    ["the day after tomorrow", "2026-09-29", "2026-09-29"],
    ["the day before yesterday", "2026-09-25", "2026-09-25"],
    ["in two months", "2026-11-27", "2026-11-27"],
    ["two years ago", "2024-09-27", "2024-09-27"],
    ["October 2–4, 2026", "2026-10-02", "2026-10-04"],
    ["2026-10-02 to 2026-10-04", "2026-10-02", "2026-10-04"],
    ["Friday", "2026-10-02", "2026-10-02"],
    ["last Friday", "2026-09-25", "2026-09-25"],
    ["last Monday", "2026-09-21", "2026-09-21"],
    ["September 27", "2026-09-27", "2026-09-27"],
    ["September 26", "2027-09-26", "2027-09-26"],
    ["February 29, 2028", "2028-02-29", "2028-02-29"],
  ])("resolves %s", (phrase, start, end) => {
    expect(dates(`Let's do that ${phrase}`)).toEqual([expect.objectContaining({ text: phrase, start, end })]);
  });

  for (let amount = 1; amount <= 25; amount += 1) {
    for (const [unit, daysPerUnit] of [["days", 1], ["weeks", 7]] as const) {
      for (const direction of [-1, 1]) {
        const phrase = direction === 1 ? `in ${amount} ${unit}` : `${amount} ${unit} ago`;
        it(`resolves ${phrase}`, () => {
          const expected = new Date(Date.UTC(2026, 8, 27 + amount * daysPerUnit * direction)).toISOString().slice(0, 10);
          expect(dates(phrase)).toEqual([expect.objectContaining({ start: expected, end: expected })]);
        });
      }
    }
  }

  it("uses the sender's local date, including DST and year rollover", () => {
    expect(dates("tomorrow", { ...reference, timeZone: "Asia/Tokyo" })[0]?.start).toBe("2026-09-29");
    expect(dates("next weekend", { ...reference, sentAtMs: Date.parse("2026-12-31T22:00:00Z") })[0])
      .toMatchObject({ start: "2027-01-01", end: "2027-01-03" });
    expect(dates("tomorrow", { ...reference, sentAtMs: Date.parse("2026-03-08T06:30:00Z") })[0]?.start).toBe("2026-03-08");
    expect(dates("in two days", { ...reference, sentAtMs: Date.parse("2026-10-31T20:00:00Z") })[0]?.start).toBe("2026-11-02");
  });

  it("flags conventions and leaves conversation-dependent expressions unresolved", () => {
    expect(dates("next Friday")[0]?.interpretation).toBeTruthy();
    expect(dates("03/04/2027")[0]?.interpretation).toContain("month/day");
    for (const text of ["the following weekend", "two days after we arrive", "the weekend after that", "the weekend after next"]) {
      const context = resolveDateContext(text, reference);
      expect(context.ranges).toEqual([]);
      expect(context.unresolved).not.toEqual([]);
    }
  });

  it("skips code, links, times without dates and false positives; bounds input and output", () => {
    expect(dates("May I run `tomorrow`? https://example.com/2026-10-02 at 4pm")).toEqual([]);
    expect(dates("```\nnext weekend\n``` nothing to do")).toEqual([]);
    expect(dates("x".repeat(20_000) + " tomorrow")).toEqual([]);
    expect(dates(Array.from({ length: 30 }, (_, i) => `October ${i + 1}, 2026`).join("; ")).length).toBeLessThanOrEqual(8);
    expect(() => dates("tomorrow", { ...reference, timeZone: "bad/timezone" })).not.toThrow();
    expect(dates("tomorrow", { ...reference, sentAtMs: NaN })).toEqual([]);
  });
});

it("extracts only anchored memory dates, preserving an event's full interval", () => {
  expect(extractAbsoluteDateRanges("ACL: 2026-10-02 to 2026-10-04 in Austin")).toEqual([
    expect.objectContaining({ start: "2026-10-02", end: "2026-10-04" }),
  ]);
  expect(extractAbsoluteDateRanges("October 2–4, 2026")[0]).toMatchObject({ start: "2026-10-02", end: "2026-10-04" });
  expect(extractAbsoluteDateRanges("next weekend; October 2; tomorrow")).toEqual([]);
});

it("hands off the original message time once, independently of the [time] display", () => {
  const handoff = createDateContextHandoff(reference.timeZone);
  const unbind = bindDateContextHandoff(handoff);
  try {
    handoff.prepare({ text: "next weekend", sentAtMs: reference.sentAtMs });
    expect(takePreparedDateContext("Scheduled job 'x' fired.\n\nnext weekend")).toBeUndefined();
    const context = takePreparedDateContext("[telegram|actor:Isaac] next weekend\n\n[time] 2029-01-01 12:00:00 UTC");
    expect(context?.reference).toBe("2026-09-28T05:12:17.000Z");
    expect(context?.ranges[0]?.start).toBe("2026-10-02");
    expect(takePreparedDateContext("[telegram] next weekend")).toBeUndefined();
    handoff.prepare({ text: "tomorrow", sentAtMs: reference.sentAtMs });
    expect(takePreparedDateContext("[telegram] something else")).toBeUndefined();
    expect(takePreparedDateContext("[telegram] tomorrow")).toBeUndefined();
    handoff.prepare({ text: "tomorrow" });
    expect(takePreparedDateContext("[telegram] tomorrow")).toBeUndefined();
    handoff.prepare({ text: "hello\n\n[reply] next weekend", sentAtMs: reference.sentAtMs });
    expect(takePreparedDateContext("[telegram] hello\n\n[reply] next weekend")).toBeUndefined();
  } finally { unbind(); }
  expect(takePreparedDateContext("[telegram] next weekend")).toBeUndefined();
});
