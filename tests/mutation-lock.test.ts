import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withMutationLock } from "../.pi/lib/mutation-lock.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cooperative mutation locking", () => {
  it("rejects an unsafe parent before creating a lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "mutation-parent-"));
    roots.push(root);
    await chmod(root, 0o777);
    const path = join(root, "lock.sqlite");
    await expect(withMutationLock(path, async () => true)).rejects.toThrow(/private.*directory/);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out while another process holds the lock and recovers after that process is killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mutation-lock-"));
    roots.push(root);
    const lock = join(root, "lock.sqlite");
    const moduleUrl = pathToFileURL(resolve(".pi/lib/mutation-lock.mjs")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { withMutationLock } from ${JSON.stringify(moduleUrl)};
      await withMutationLock(${JSON.stringify(lock)}, async () => {
        process.stdout.write('locked');
        await new Promise(() => setInterval(() => {}, 1000));
      });
    `], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      await expect(withMutationLock(lock, async () => "wrong", { timeoutMs: 50 }))
        .rejects.toMatchObject({ code: "MUTATION_BUSY" });
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await expect(withMutationLock(lock, async () => "recovered")).resolves.toBe("recovered");
    // The SQLite lock is advisory metadata, never a copy of canonical content.
    expect((await readFile(lock)).length).toBe(0);
  });

  it("releases after callback failure and rejects symlinked lock files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mutation-lock-"));
    roots.push(root);
    const lock = join(root, "lock.sqlite");
    await expect(withMutationLock(lock, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(withMutationLock(lock, async () => true)).resolves.toBe(true);
    const alias = join(root, "alias.sqlite");
    await symlink(lock, alias);
    await expect(withMutationLock(alias, async () => true)).rejects.toThrow(/regular file/);
  });
});
