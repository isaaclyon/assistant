import { describe, expect, it } from "vitest";

import {
  buildReservationUrl,
  parseAvailability,
} from "../.pi/skills/reserve-restaurant/scripts/opentable-search.mjs";

describe("OpenTable search helper", () => {
  it("adds the requested date, time, and party size to a restaurant URL", () => {
    expect(
      buildReservationUrl("https://www.opentable.com/r/matteo", {
        date: "2026-07-25",
        time: "19:00",
        covers: 2,
      }),
    ).toBe(
      "https://www.opentable.com/r/matteo?dateTime=2026-07-25T19%3A00%3A00&covers=2",
    );
  });

  it("extracts reservation buttons while preserving seating/terms text", () => {
    expect(
      parseAvailability(
        'button "Reserve table at Matteo at 7:15 PM on July 25, for a party of 2"\n' +
          'button "Reserve table at Matteo at 7:30 PM on July 25, for a party of 2 and redeem +1,000 pts"',
      ),
    ).toEqual([
      { time: "7:15 PM", label: "Reserve table at Matteo at 7:15 PM on July 25, for a party of 2" },
      { time: "7:30 PM", label: "Reserve table at Matteo at 7:30 PM on July 25, for a party of 2 and redeem +1,000 pts" },
    ]);
  });
});
