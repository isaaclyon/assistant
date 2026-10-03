import { expect, it } from "vitest";
import { isFeatureEnabled } from "../src/feature-flags.js";

it("keeps recall and routing opt-in and preserves key-gated semantic search", () => {
  expect(isFeatureEnabled("PI_TELEGRAM_MEMORY_RECALL", {})).toBe(false);
  expect(isFeatureEnabled("PI_TELEGRAM_SESSION_ROUTING", {})).toBe(false);
  expect(isFeatureEnabled("PI_TELEGRAM_MEMORY_SEMANTIC", {})).toBe(true);
});

it.each([
  ["PI_TELEGRAM_MEMORY_RECALL", "jev"],
  ["PI_TELEGRAM_SESSION_ROUTING", "jev"],
  ["PI_TELEGRAM_MEMORY_SEMANTIC", "on"],
] as const)("validates and independently switches %s", (key, enabled) => {
  expect(isFeatureEnabled(key, { [key]: enabled })).toBe(true);
  expect(isFeatureEnabled(key, { [key]: " off " })).toBe(false);
  for (const value of ["true", "typo", ""]) {
    expect(() => isFeatureEnabled(key, { [key]: value })).toThrow(`${key} must be ${enabled} or off`);
  }
});
