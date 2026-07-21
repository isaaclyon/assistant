import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("deployment preflight", () => {
  it("validates jobs with the new release before stopping the live service", async () => {
    const script = await readFile("scripts/deploy-local.sh", "utf8");
    const preflight = script.indexOf('"$RELEASE_PATH/dist/src/jobs-check.js"');
    const stop = script.indexOf('systemctl --user stop "$SERVICE"');

    expect(preflight).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(preflight);
    expect(script).toContain(
      '--property="EnvironmentFile=-$HOME/.config/pi-telegram-bridge/environment"',
    );
  });
});
