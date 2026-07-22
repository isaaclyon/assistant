import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writeBridgeFleetUnits } from "../src/fleet-installer.js";

describe("fleet unit installation", () => {
  it("writes only the validated configured units with private modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-fleet-units-"));
    const units = ["isaac", "emma", "shared", "builder"].map((id) => ({
      unitName: `pi-telegram-bridge-${id}.service`,
      contents: `[Service]\nEnvironment=INSTANCE=${id}\n`,
    }));

    const paths = await writeBridgeFleetUnits(root, units);

    expect(paths.map((path) => path.split("/").at(-1))).toEqual(
      units.map((unit) => unit.unitName),
    );
    for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("requires explicit retirement instead of deleting a removed instance unit", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-fleet-retire-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "pi-telegram-bridge-retired.service"), "old\n", {
      mode: 0o600,
    });

    await expect(
      writeBridgeFleetUnits(root, [
        { unitName: "pi-telegram-bridge-isaac.service", contents: "new\n" },
      ]),
    ).rejects.toThrow(/explicit retirement.*retired/is);
  });
});
