import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlaceInsertion } from "../src/places-ranking.js";
import { runPlacesCli } from "../src/places-cli.js";
import { openPlacesStore } from "../src/places-store.js";

describe("places operator CLI", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("backs up active state and exports only published data with private modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "places-cli-"));
    roots.push(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir);
    const source = openPlacesStore(join(stateDir, "places.db"));
    const category = source.listCategories()[0];
    if (!category) throw new Error("missing category");
    source.createInsertion({
      id: "active",
      ownerKey: "instance:isaac:principal:isaac",
      candidateId: "candidate",
      name: "Private candidate",
      categoryId: category.id,
      sentiment: "liked",
      state: createPlaceInsertion([], "liked"),
      now: 1,
    });
    source.close();
    const backupPath = join(root, "backup", "places.db");
    const exportPath = join(root, "backup", "places.json");

    await runPlacesCli(["backup", backupPath], { PI_TELEGRAM_BRIDGE_STATE_DIR: stateDir });
    await runPlacesCli(["export", exportPath], { PI_TELEGRAM_BRIDGE_STATE_DIR: stateDir });

    const backup = openPlacesStore(backupPath);
    expect(backup.getActiveInsertion("instance:isaac:principal:isaac")?.id).toBe("active");
    backup.close();
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect((await stat(exportPath)).mode & 0o777).toBe(0o600);
    const published = JSON.parse(await readFile(exportPath, "utf8")) as unknown;
    expect(JSON.stringify(published)).not.toContain("Private candidate");
  });

  it("never overwrites an existing file or follows a destination symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "places-cli-safe-"));
    roots.push(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir);
    openPlacesStore(join(stateDir, "places.db")).close();
    const existing = join(root, "existing");
    const linkPath = join(root, "linked-export");
    await writeFile(existing, "keep me", "utf8");
    await symlink(existing, linkPath);

    await expect(runPlacesCli(["backup", existing], { PI_TELEGRAM_BRIDGE_STATE_DIR: stateDir })).rejects.toThrow();
    await expect(runPlacesCli(["export", linkPath], { PI_TELEGRAM_BRIDGE_STATE_DIR: stateDir })).rejects.toThrow();
    await expect(readFile(existing, "utf8")).resolves.toBe("keep me");
  });
});
