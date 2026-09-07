import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recoveryStartupAllowed } from "../src/recovery-start-check.js";

describe("maintenance boot guard", () => {
  it("permits only the live deployment authorization while the hold exists, and fails closed after reboot", async () => {
    const root = await mkdtemp(join(tmpdir(), "recovery-guard-"));
    try {
      expect(await recoveryStartupAllowed(root)).toBe(true);
      await writeFile(join(root, ".recovery-maintenance"), JSON.stringify({ version: 1,
        snapshotDir: "/synthetic/snapshot", authorization: "11111111-1111-4111-8111-111111111111" }), { mode: 0o600 });
      expect(await recoveryStartupAllowed(root, "11111111-1111-4111-8111-111111111111")).toBe(true);
      // Manager environment is volatile: a reboot before the final commit cannot start enabled units.
      expect(await recoveryStartupAllowed(root)).toBe(false);
      expect(await recoveryStartupAllowed(root, "different")).toBe(false);
      await writeFile(join(root, ".recovery-maintenance"), "malformed");
      expect(await recoveryStartupAllowed(root)).toBe(false);
      await rm(join(root, ".recovery-maintenance"));
      expect(await recoveryStartupAllowed(root)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
