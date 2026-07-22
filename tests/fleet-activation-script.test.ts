import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("fleet activation script", () => {
  it("disables the compatibility singleton and restores its enablement on rollback", async () => {
    const source = await readFile("scripts/activate-fleet.sh", "utf8");

    expect(source).toContain('systemctl --user disable --now "$LEGACY_UNIT"');
    expect(source).toContain('systemctl --user enable "$LEGACY_UNIT"');
  });
});
