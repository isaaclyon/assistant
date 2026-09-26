import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("deployment preflight", () => {
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
