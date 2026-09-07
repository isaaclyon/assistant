import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildReservationUrl,
  analyzeSnapshot,
  parseAvailability,
  searchOpenTable,
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

  it.each([
    ["rejects a non-OpenTable URL", "https://evil.example/r/matteo", { date: "2026-07-25", time: "19:00", covers: 2 }],
    ["rejects an insecure URL", "http://www.opentable.com/r/matteo", { date: "2026-07-25", time: "19:00", covers: 2 }],
    ["rejects a non-restaurant path", "https://www.opentable.com/s?term=pizza", { date: "2026-07-25", time: "19:00", covers: 2 }],
    ["rejects an impossible date", "https://www.opentable.com/r/matteo", { date: "2026-02-30", time: "19:00", covers: 2 }],
    ["rejects an impossible time", "https://www.opentable.com/r/matteo", { date: "2026-07-25", time: "25:00", covers: 2 }],
    ["rejects an unreasonable party size", "https://www.opentable.com/r/matteo", { date: "2026-07-25", time: "19:00", covers: 21 }],
  ])("%s", (_label, url, options) => {
    expect(() => buildReservationUrl(url, options)).toThrow();
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

  it("distinguishes live availability, blocked pages, and unverifiable snapshots", () => {
    expect(
      analyzeSnapshot('button "Reserve table at Matteo at 7:15 PM on July 25, for a party of 2"'),
    ).toMatchObject({ status: "available" });
    expect(analyzeSnapshot('heading "Access Denied"')).toEqual({
      status: "blocked",
      availability: [],
    });
    expect(analyzeSnapshot("\n")).toEqual({
      status: "unverified",
      availability: [],
    });
    expect(analyzeSnapshot('link "Menu"')).toEqual({
      status: "no_slots_visible",
      availability: [],
    });
  });

  it("never treats a blocked page with background reservation buttons as availability", () => {
    expect(analyzeSnapshot('heading "Verify you are human"\nbutton "Reserve table at Matteo at 7:15 PM on July 25, for a party of 2"'))
      .toEqual({ status: "blocked", availability: [] });
  });

  it.each([
    ["July 26", 2], ["July 25", 4], ["July 25, 2027", 2], ["an unknown date", 2],
  ])("rejects reservation labels that do not match requested date and party (%s, %s)", (date, covers) => {
    expect(analyzeSnapshot(`button "Reserve table at Matteo at 7:15 PM on ${date}, for a party of ${covers}"`, {
      date: "2026-07-25", covers: 2,
    })).toEqual({ status: "unverified", availability: [] });
  });

  it.each(["July 25,", "July 25", "July 25, 2026,"])("keeps matching date labels (%s) and alternative times", (date) => {
    expect(analyzeSnapshot(`button "Reserve table at Matteo at 7:15 PM on ${date} for a party of 2"`, {
      date: "2026-07-25", covers: 2,
    })).toMatchObject({ status: "available", availability: [{ time: "7:15 PM" }] });
  });

  it.each(["running", "stopped", "owned"])("closes only its own tabs and respects atomic browser ownership (%s)", async (initialStatus) => {
    const root = await mkdtemp(join(tmpdir(), "opentable-search-test-"));
    const helper = join(root, "fake-helper.mjs");
    const log = join(root, "calls.jsonl");
    await writeFile(
      helper,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const [operation, session, separator, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_HELPER_LOG, JSON.stringify({ operation, session, args }) + "\\n");
if (operation === "status") console.log(JSON.stringify({ status: ${JSON.stringify(initialStatus)}, session }));
else if (operation === "start") console.log(JSON.stringify({ status: "running", created: ${initialStatus === "owned"}, launchId: "synthetic-launch" }));
else if (operation === "run" && args[0] === "snapshot") console.log('button "Reserve table at Matteo at 7:15 PM on July 25, for a party of 2"');
else console.log(JSON.stringify({ status: operation === "stop" ? "stopped" : "running" }));
`,
    );
    await chmod(helper, 0o755);
    const previousHelper = process.env.PI_AGENT_BROWSER_HELPER;
    const previousLog = process.env.FAKE_HELPER_LOG;
    process.env.PI_AGENT_BROWSER_HELPER = helper;
    process.env.FAKE_HELPER_LOG = log;
    try {
      const result = await searchOpenTable({
        date: "2026-07-25",
        time: "19:00",
        covers: 2,
        session: "default",
        restaurants: [
          { name: "Matteo", url: "https://www.opentable.com/r/matteo" },
        ],
      });
      expect(result[0]).toMatchObject({ status: "available" });
      expect(result[0].availability).toEqual([
        {
          time: "7:15 PM",
          label: "Reserve table at Matteo at 7:15 PM on July 25, for a party of 2",
        },
      ]);
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.some((call) => call.operation === "stop")).toBe(initialStatus === "owned");
      if (initialStatus === "owned") expect(calls.find((call) => call.operation === "stop").args).toEqual(["synthetic-launch"]);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "run",
            args: expect.arrayContaining(["tab", "close"]),
          }),
        ]),
      );
    } finally {
      if (previousHelper === undefined) delete process.env.PI_AGENT_BROWSER_HELPER;
      else process.env.PI_AGENT_BROWSER_HELPER = previousHelper;
      if (previousLog === undefined) delete process.env.FAKE_HELPER_LOG;
      else process.env.FAKE_HELPER_LOG = previousLog;
      await rm(root, { recursive: true, force: true });
    }
  });
});
