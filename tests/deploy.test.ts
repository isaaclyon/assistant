import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("deployment preflight", () => {
  it("validates jobs with the new release before stopping the live service", async () => {
    const script = await readFile("scripts/deploy-local.sh", "utf8");
    const preflight = script.indexOf('"$RELEASE_PATH/dist/src/jobs-check.js"');
    const stop = script.indexOf('recovery_prepare local');

    expect(preflight).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(preflight);
    expect(script).toContain(
      '--property="EnvironmentFile=-$HOME/.config/pi-telegram-bridge/environment"',
    );
  });

  it("never automatically restarts the old singleton binary after candidate startup", async () => {
    const script = await readFile("scripts/deploy-local.sh", "utf8");
    expect(script).toContain("recovery_hold");
    expect(script).not.toContain('cp "$UNIT_BACKUP" "$UNIT_PATH"');
    const barrier = script.indexOf("recovery_started");
    expect(barrier).toBeGreaterThan(-1);
    expect(barrier).toBeLessThan(script.indexOf('systemctl --user restart "$SERVICE"'));
    const installer = await readFile("src/install-service.ts", "utf8");
    const singleton = installer.slice(0, installer.indexOf("async function installInstanceFleet"));
    expect(singleton).toContain('process.env.PI_TELEGRAM_BRIDGE_INSTALL_NO_START !== "1"');
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
