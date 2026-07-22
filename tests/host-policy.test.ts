import { describe, expect, it } from "vitest";

import {
  resolveTelegramHostHouseholdGroup,
  shouldStartJobScheduler,
} from "../src/host.js";

describe("bridge host instance policy", () => {
  it("starts scheduled-work evaluation only in the coordinator process", () => {
    expect(shouldStartJobScheduler({ jobsRole: "coordinator" })).toBe(true);
    expect(shouldStartJobScheduler({ jobsRole: "target-only" })).toBe(false);
    expect(shouldStartJobScheduler({ jobsRole: "disabled" })).toBe(false);
  });

  it("keeps scheduler ownership in the bounded singleton compatibility host", () => {
    expect(shouldStartJobScheduler({})).toBe(true);
  });

  it("maps the strict household manifest surface to stable fork actor labels", () => {
    expect(
      resolveTelegramHostHouseholdGroup({
        telegramSurface: {
          type: "household-group",
          chatId: -100123,
          actors: { isaac: 101, emma: 202 },
        },
      }),
    ).toEqual({
      kind: "household-group",
      chatId: -100123,
      actors: [
        { userId: 101, label: "Isaac" },
        { userId: 202, label: "Emma" },
      ],
    });
    expect(resolveTelegramHostHouseholdGroup({})).toBeUndefined();
  });
});
