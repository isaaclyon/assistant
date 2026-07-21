import { describe, expect, it } from "vitest";

import {
  cutoffDate,
  parseOverdueUnapprovedIds,
} from "../src/checkers/ynab-unapproved.js";

describe("YNAB unapproved checker", () => {
  it("uses five calendar days before the current Mountain date", () => {
    expect(cutoffDate(new Date("2026-07-21T05:30:00Z"))).toBe("2026-07-15");
    expect(cutoffDate(new Date("2026-07-21T06:30:00Z"))).toBe("2026-07-16");
  });

  it("returns sorted IDs for unapproved, non-deleted transactions through the cutoff", () => {
    const ids = parseOverdueUnapprovedIds(
      [
        { id: "b", date: "2026-07-16", approved: false, deleted: false },
        { id: "ignored-new", date: "2026-07-17", approved: false, deleted: false },
        { id: "ignored-approved", date: "2026-07-10", approved: true, deleted: false },
        { id: "ignored-deleted", date: "2026-07-10", approved: false, deleted: true },
        { id: "a", date: "2026-07-01", approved: false, deleted: false },
      ],
      "2026-07-16",
    );

    expect(ids).toEqual(["a", "b"]);
  });

  it("rejects malformed transaction output", () => {
    expect(() =>
      parseOverdueUnapprovedIds([{ id: "a", date: "not-a-date", approved: false }], "2026-07-16"),
    ).toThrow(/invalid transaction/i);
  });
});
