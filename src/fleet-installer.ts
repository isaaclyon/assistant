import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RenderedInstanceServiceUnit } from "./service-unit.js";

const UNIT_PATTERN = /^pi-telegram-bridge-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.service$/;

export async function writeBridgeFleetUnits(
  unitDirectory: string,
  units: readonly RenderedInstanceServiceUnit[],
): Promise<string[]> {
  if (units.length === 0) throw new Error("Fleet installation requires units");
  const expectedNames = new Set<string>();
  for (const unit of units) {
    if (!UNIT_PATTERN.test(unit.unitName)) {
      throw new Error(`Invalid bridge fleet unit name: ${unit.unitName}`);
    }
    if (expectedNames.has(unit.unitName)) {
      throw new Error(`Duplicate bridge fleet unit name: ${unit.unitName}`);
    }
    expectedNames.add(unit.unitName);
  }

  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const existingNames = (await readdir(unitDirectory)).filter((name) =>
    UNIT_PATTERN.test(name),
  );
  const retired = existingNames.filter((name) => !expectedNames.has(name));
  if (retired.length > 0) {
    throw new Error(
      `Bridge instance removal requires explicit retirement before installation: ${retired.join(", ")}`,
    );
  }

  const paths: string[] = [];
  for (const unit of units) {
    const path = join(unitDirectory, unit.unitName);
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, unit.contents, { mode: 0o600 });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    paths.push(path);
  }
  return paths;
}
