import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("deployment preflight", () => {
  it("stages releases without group/other write access even under a permissive runner", async () => {
    const script = await readFile("scripts/deploy-local.sh", "utf8");
    const root = await mkdtemp(join(tmpdir(), "release-permissions-"));
    try {
      const preamble = script.slice(0, script.indexOf("EXPECTED_SHA="));
      execFileSync("bash", ["-c", `umask 000\n${preamble}\nmkdir "$RELEASE_TEST_DIR/staged"; touch "$RELEASE_TEST_DIR/staged/file"`],
        { env: { ...process.env, RELEASE_TEST_DIR: root }, timeout: 5000 });
      for (const name of ["staged", "staged/file"]) expect((await stat(join(root, name))).mode & 0o022).toBe(0);
      expect(script.indexOf('chmod -R go-w "$STAGING_PATH"')).toBeLessThan(script.indexOf('mv "$STAGING_PATH" "$RELEASE_PATH"'));
      expect(script).toContain('chmod -R go-w "$STAGING_PATH"');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refuses to deploy without a fleet manifest before building or touching services", async () => {
    const script = await readFile("scripts/deploy-local.sh", "utf8");
    const guard = script.indexOf('if [[ ! -f "$FLEET_MANIFEST" ]]; then');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(script.indexOf("flock -w 900 9"));
    expect(script).not.toContain("install-service.js");
    expect(script).not.toContain("pi-telegram-bridge.service");
  });

  it("notifies Telegram only after the fleet checkout advances", async () => {
    const script = await readFile("scripts/deploy-local.sh", "utf8");
    const fleetActivation = script.indexOf('bash "$RELEASE_PATH/scripts/activate-fleet.sh"');
    const checkoutAdvance = script.indexOf('git reset --hard "$EXPECTED_SHA"', fleetActivation);
    const notification = script.indexOf('"$RELEASE_PATH/dist/src/deployment-notify.js"');

    expect(fleetActivation).toBeGreaterThan(-1);
    expect(checkoutAdvance).toBeGreaterThan(fleetActivation);
    expect(notification).toBeGreaterThan(checkoutAdvance);
  });
});
