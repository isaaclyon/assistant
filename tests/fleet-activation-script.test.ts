import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("fleet activation script", () => {
  it("quiesces and snapshots before installation, then crosses the durable startup barrier", async () => {
    const source = await readFile("scripts/activate-fleet.sh", "utf8");
    expect(source.indexOf('recovery_prepare "$COORDINATOR_ID"')).toBeGreaterThan(-1);
    expect(source.indexOf('recovery_prepare "$COORDINATOR_ID"')).toBeLessThan(source.indexOf('"$RELEASE_PATH/dist/src/install-service.js"'));
    expect(source.indexOf('recovery_started')).toBeLessThan(source.indexOf('systemctl --user restart "$service"'));
    expect(source).toContain("recovery_hold");
    expect(source).not.toContain('systemctl --user restart "$unit_name"');
    expect(source).not.toContain('rm -rf "$BACKUP_DIR"');
  });
});
