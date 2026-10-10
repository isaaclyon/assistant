import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyIsolatedMigration, inventoryIsolatedMigration, relocateMigrationJson, relocateSessionHeader, type IsolatedMigrationPlan } from "../src/isolated-migration.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const paths = [{ from: "/home/old/work", to: "/var/lib/personal/work" }];
describe("selected personal migration", () => {
  it("relocates structured paths and rejects embedded operational references", () => {
    expect(relocateMigrationJson({ cwd: "/home/old/work", nested: ["/home/old/work/task.json"], other: "/home/old/worker" }, paths))
      .toEqual({ cwd: "/var/lib/personal/work", nested: ["/var/lib/personal/work/task.json"], other: "/home/old/worker" });
    expect(() => relocateMigrationJson({ prompt: "Run /home/old/work/task.json today" }, paths)).toThrow("embedded path");
  });
  it("updates the session header while preserving historical conversation bytes", () => {
    const history = '{"type":"message","message":{"text":"/home/old/work"}}\n';
    const result = relocateSessionHeader('{"type":"session","cwd":"/home/old/work","id":"synthetic"}\n' + history, paths);
    expect(JSON.parse(result.split("\n")[0]!).cwd).toBe("/var/lib/personal/work");
    expect(result.slice(result.indexOf("\n") + 1)).toBe(history);
    expect(() => relocateSessionHeader(history, paths)).toThrow("session header");
  });
  async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "isolated-migration-"))); roots.push(root);
    const source = join(root, "source"), destination = join(root, "destination"), checkpoint = join(root, "checkpoint");
    await mkdir(source, { mode: 0o700 }); await mkdir(checkpoint, { mode: 0o700 });
    await writeFile(join(source, "settings.json"), JSON.stringify({ cwd: "/home/old/work" }), { mode: 0o600 });
    const plan: IsolatedMigrationPlan = { version: 1, relocations: paths, assets: [{ role: "runtime-state", source, destination,
      sourceUid: process.getuid!(), uid: process.getuid!(), gid: process.getgid!(), exclude: [], transforms: [{ path: "settings.json", kind: "json-paths" }] }] };
    return { root, source, destination, checkpoint, plan };
  }
  it("inventories selected data without writing and refreshes only with stopped writers", async () => {
    const f = await fixture();
    expect((await inventoryIsolatedMigration(f.plan))[0]).toMatchObject({ role: "runtime-state", files: 1 });
    await expect(applyIsolatedMigration(f.plan, f.checkpoint, async () => { throw new Error("writer active"); })).rejects.toThrow("writer active");
    await expect(readFile(join(f.destination, "settings.json"))).rejects.toThrow();
    // Changes made after the inventory must be captured at the stopped-writer boundary.
    await writeFile(join(f.source, "accepted"), "new work", { mode: 0o600 });
    await applyIsolatedMigration(f.plan, f.checkpoint, async () => {});
    expect(await readFile(join(f.destination, "accepted"), "utf8")).toBe("new work");
    expect(JSON.parse(await readFile(join(f.destination, "settings.json"), "utf8"))).toEqual({ cwd: "/var/lib/personal/work" });
    await applyIsolatedMigration(f.plan, f.checkpoint, async () => {});
    await writeFile(join(f.checkpoint, "candidate-started"), "{}", { mode: 0o600 });
    await expect(applyIsolatedMigration(f.plan, f.checkpoint, async () => {})).rejects.toThrow("candidate started");
  });
  it("rejects escaping links, overlapping assets, and unselected transformations", async () => {
    const f = await fixture();
    await symlink("../outside", join(f.source, "link"));
    await expect(inventoryIsolatedMigration(f.plan)).rejects.toThrow("link");
    await rm(join(f.source, "link"));
    await expect(inventoryIsolatedMigration({ ...f.plan, assets: [...f.plan.assets, { ...f.plan.assets[0]!, role: "overlap" }] })).rejects.toThrow("overlap");
    f.plan.assets[0]!.transforms = [{ path: "../outside", kind: "json-paths" }];
    await expect(inventoryIsolatedMigration(f.plan)).rejects.toThrow("transform");
  });
});
