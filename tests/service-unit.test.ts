import { describe, expect, it } from "vitest";

import { renderServiceUnit } from "../src/service-unit.js";

describe("renderServiceUnit", () => {
  it("pins the node executable, persistent paths, and restart policy", () => {
    const unit = renderServiceUnit({
      config: {
        agentDir: "/home/test/.pi/agent",
        cwd: "/home/test",
        sessionDir: "/home/test/.local/state/pi-telegram-bridge/sessions",
        stateDir: "/home/test/.local/state/pi-telegram-bridge",
      },
      nodePath: "/opt/node/bin/node",
      projectDir: "/srv/pi bridge",
    });

    expect(unit).toContain(
      'ExecStart="/opt/node/bin/node" "/srv/pi bridge/dist/src/daemon.js"',
    );
    expect(unit).toContain("WorkingDirectory=/home/test");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain('Environment="PI_TELEGRAM_BRIDGE_CWD=/home/test"');
    expect(unit).toContain("UMask=0077");
  });
});
