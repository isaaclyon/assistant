import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRepositoryInspector,
  validatePublicWebUrl,
} from "../.pi/extensions/subagents/inspection.js";

describe("subagent read-only inspection boundary", () => {
  it("reads and searches regular files inside configured roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-root-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const needle = 1;\n");
    const inspector = createRepositoryInspector([root]);

    await expect(inspector.read("src/a.ts")).resolves.toContain("needle");
    await expect(inspector.search("needle")).resolves.toMatchObject({
      matches: [{ path: "src/a.ts", line: 1 }],
    });
  });

  it("denies traversal, symlink escapes, special files, and mutation APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-root-"));
    const outside = await mkdtemp(join(tmpdir(), "subagent-outside-"));
    await writeFile(join(outside, "secret"), "nope");
    await symlink(join(outside, "secret"), join(root, "escape"));
    const inspector = createRepositoryInspector([root]);

    await expect(inspector.read("../secret")).rejects.toThrow(/outside/i);
    await expect(inspector.read("escape")).rejects.toThrow(/outside|symlink/i);
    expect(inspector).not.toHaveProperty("write");
    expect(inspector).not.toHaveProperty("exec");
  });

  it("rejects local, credential-bearing, and non-http web targets", async () => {
    await expect(validatePublicWebUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(validatePublicWebUrl("http://127.0.0.1/admin")).rejects.toThrow();
    await expect(validatePublicWebUrl("https://user:pass@example.com/")).rejects.toThrow();
  });
});
