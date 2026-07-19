import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_RELATIVE_PATH,
  resolveMemoryDirectory,
} from "../.pi/skills/personal-memory/scripts/config.mjs";
import {
  errorEnvelope,
  successEnvelope,
} from "../.pi/skills/personal-memory/scripts/protocol.mjs";

describe("personal memory script configuration", () => {
  it("defaults to the private bridge data directory", () => {
    expect(resolveMemoryDirectory({}, "/home/tester")).toBe(
      join("/home/tester", DEFAULT_MEMORY_RELATIVE_PATH),
    );
  });

  it("accepts an absolute override", () => {
    expect(
      resolveMemoryDirectory(
        { PI_TELEGRAM_MEMORY_DIR: "/srv/private-memory" },
        "/home/tester",
      ),
    ).toBe("/srv/private-memory");
  });

  it("resolves a relative override from the user home", () => {
    expect(
      resolveMemoryDirectory(
        { PI_TELEGRAM_MEMORY_DIR: "vaults/personal" },
        "/home/tester",
      ),
    ).toBe("/home/tester/vaults/personal");
  });
});

describe("personal memory protocol envelopes", () => {
  it("uses a versioned success envelope", () => {
    expect(successEnvelope({ id: "synthetic" })).toEqual({
      schemaVersion: 1,
      ok: true,
      data: { id: "synthetic" },
    });
  });

  it("uses a versioned sanitized error envelope", () => {
    expect(errorEnvelope("INVALID_INPUT", "Request is invalid")).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: "INVALID_INPUT", message: "Request is invalid" },
    });
  });
});
