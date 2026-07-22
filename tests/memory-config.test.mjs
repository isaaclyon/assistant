import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRIDGE_STATE_RELATIVE_PATH,
  DEFAULT_MEMORY_RELATIVE_PATH,
  resolveBridgeSessionDirectory,
  resolveBridgeSessionDirectories,
  resolveMemoryDirectory,
  resolveMemoryGitAutocommit,
  resolveMemoryView,
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

  it("resolves the bridge session directory from bridge state", () => {
    expect(resolveBridgeSessionDirectory({}, "/home/tester")).toBe(
      join("/home/tester", DEFAULT_BRIDGE_STATE_RELATIVE_PATH, "sessions"),
    );
    expect(
      resolveBridgeSessionDirectory(
        { PI_TELEGRAM_BRIDGE_STATE_DIR: "state/telegram" },
        "/home/tester",
      ),
    ).toBe("/home/tester/state/telegram/sessions");
  });

  it("resolves the explicit instance principal, memory view, and fleet session roots", () => {
    expect(
      resolveMemoryView({
        PI_TELEGRAM_PRINCIPAL: "emma",
        PI_TELEGRAM_MEMORY_VIEW: "owner-and-household",
      }),
    ).toEqual({ principal: "emma", memoryView: "owner-and-household" });
    expect(
      resolveBridgeSessionDirectories({
        PI_TELEGRAM_BRIDGE_SESSION_ROOTS: JSON.stringify([
          "/state/instances/isaac/sessions",
          "/state/instances/emma/sessions",
          "/state/instances/shared/sessions",
        ]),
      }),
    ).toEqual([
      "/state/instances/isaac/sessions",
      "/state/instances/emma/sessions",
      "/state/instances/shared/sessions",
    ]);
    expect(() =>
      resolveMemoryView({
        PI_TELEGRAM_PRINCIPAL: "household",
        PI_TELEGRAM_MEMORY_VIEW: "owner-and-household",
      }),
    ).toThrow(/incompatible/i);
  });

  it("requires an explicit valid Git auto-commit opt-in", () => {
    expect(resolveMemoryGitAutocommit({})).toBe(false);
    expect(resolveMemoryGitAutocommit({ PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT: "0" })).toBe(false);
    expect(resolveMemoryGitAutocommit({ PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT: "1" })).toBe(true);
    expect(() =>
      resolveMemoryGitAutocommit({ PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT: "yes" }),
    ).toThrow(/must be 0 or 1/);
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
