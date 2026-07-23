import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPinnedLookup,
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

  it("lists directories from every configured root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "subagent-workspace-"));
    const resourceRoot = await mkdtemp(join(tmpdir(), "subagent-resource-"));
    await mkdir(join(resourceRoot, "docs"));
    await writeFile(join(resourceRoot, "docs", "adr.md"), "decision\n");
    const inspector = createRepositoryInspector([workspace, resourceRoot]);

    await expect(inspector.list("docs")).resolves.toEqual(["f adr.md"]);
    await expect(inspector.list(join(resourceRoot, "docs"))).resolves.toEqual(["f adr.md"]);
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
    await expect(validatePublicWebUrl("http://[::1]/admin")).rejects.toThrow(/local or private/i);
    await expect(validatePublicWebUrl("http://[::ffff:127.0.0.1]/admin")).rejects.toThrow(/local or private/i);
    await expect(validatePublicWebUrl("http://[::7f00:1]/admin")).rejects.toThrow(/local or private/i);
    await expect(validatePublicWebUrl("http://[fec0::1]/admin")).rejects.toThrow(/local or private/i);
    await expect(validatePublicWebUrl("http://100.64.0.1/admin")).rejects.toThrow(/local or private/i);
    await expect(validatePublicWebUrl("http://192.0.2.1/admin")).rejects.toThrow(/local or private/i);
    await expect(validatePublicWebUrl("https://user:pass@example.com/")).rejects.toThrow();
  });

  it("accepts public IPv4 and IPv6 literals", async () => {
    await expect(validatePublicWebUrl("https://1.1.1.1/")).resolves.toBeInstanceOf(URL);
    await expect(validatePublicWebUrl("https://[2606:4700:4700::1111]/")).resolves.toBeInstanceOf(URL);
  });

  it("pins requests to the addresses that passed public-network validation", async () => {
    const pinnedLookup = createPinnedLookup([{ address: "1.1.1.1", family: 4 }]);
    const result = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      pinnedLookup("attacker-controlled.example", { all: true, family: 0 }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses as Array<{ address: string; family: number }>);
      });
    });

    expect(result).toEqual([{ address: "1.1.1.1", family: 4 }]);
  });
});
