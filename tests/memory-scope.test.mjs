import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileCoreMemory, lintMemoryVault } from "../.pi/skills/personal-memory/scripts/inspect.mjs";
import { createMarkdownMemorySearchBackend } from "../.pi/skills/personal-memory/scripts/search.mjs";
import { createMarkdownMemoryStore } from "../.pi/skills/personal-memory/scripts/store.mjs";

describe("household memory scopes", () => {
  it("shows each spouse personal plus household, Shared only household, and Builder none", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-memory-scopes-"));
    const isaac = createMarkdownMemoryStore({
      root,
      principal: "isaac",
      memoryView: "owner-and-household",
    });
    const emma = createMarkdownMemoryStore({
      root,
      principal: "emma",
      memoryView: "owner-and-household",
    });
    const shared = createMarkdownMemoryStore({
      root,
      principal: "household",
      memoryView: "household",
    });
    const builder = createMarkdownMemoryStore({
      root,
      principal: "engineering",
      memoryView: "none",
    });
    const note = (title, scope) => ({
      type: "preference",
      title,
      tags: [],
      body: `${title} #core\n`,
      scope,
    });

    const isaacPersonal = await isaac.add(note("Isaac personal", "personal"));
    await isaac.add(note("Household shared", "household"));
    await emma.add(note("Emma personal", "personal"));

    expect((await isaac.list()).map((memory) => memory.title).sort()).toEqual([
      "Household shared",
      "Isaac personal",
    ]);
    expect((await emma.list()).map((memory) => memory.title).sort()).toEqual([
      "Emma personal",
      "Household shared",
    ]);
    expect((await shared.list()).map((memory) => memory.title)).toEqual([
      "Household shared",
    ]);
    expect(await builder.list()).toEqual([]);
    await expect(emma.read({ id: isaacPersonal.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(shared.add(note("Wrongly personal", "personal"))).rejects.toMatchObject({
      code: "INVALID_SCOPE",
    });
    await expect(isaac.add(note("Legacy shared spelling", "shared"))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    const emmaSearch = createMarkdownMemorySearchBackend({
      root,
      principal: "emma",
      memoryView: "owner-and-household",
    });
    await expect(emmaSearch.search({ query: "Isaac personal" })).resolves.toMatchObject({
      results: [],
    });

    const isaacCore = await compileCoreMemory({
      root,
      principal: "isaac",
      memoryView: "owner-and-household",
    });
    expect(isaacCore.text).toContain("Isaac personal");
    expect(isaacCore.text).toContain("Household shared");
    expect(isaacCore.text).not.toContain("Emma personal");
    const sharedCore = await compileCoreMemory({
      root,
      principal: "household",
      memoryView: "household",
    });
    expect(sharedCore.text).toContain("Household shared");
    expect(sharedCore.text).not.toContain("Isaac personal");
    expect(sharedCore.text).not.toContain("Emma personal");
    await expect(
      compileCoreMemory({
        root,
        principal: "engineering",
        memoryView: "none",
      }),
    ).resolves.toMatchObject({ text: "" });
  });

  it("defaults from the trusted view and promotes personal memory only by revision-checked scope update", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-memory-promotion-"));
    const isaac = createMarkdownMemoryStore({
      root,
      principal: "isaac",
      memoryView: "owner-and-household",
    });
    const shared = createMarkdownMemoryStore({
      root,
      principal: "household",
      memoryView: "household",
    });
    const added = await isaac.add({
      type: "preference",
      title: "Trip preference",
      tags: [],
      body: "Prefers morning flights.\n",
    });
    expect(added).toMatchObject({ scope: "personal", owner: "isaac" });
    await expect(shared.read({ id: added.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const current = await isaac.read({ id: added.id });
    await expect(
      isaac.update({
        id: added.id,
        ifRevision: "sha256:stale",
        patch: { scope: "household" },
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const promoted = await isaac.update({
      id: added.id,
      ifRevision: current.revision,
      patch: { scope: "household" },
    });
    expect(promoted).toMatchObject({ scope: "household" });
    expect(promoted).not.toHaveProperty("owner");
    await expect(shared.read({ id: added.id })).resolves.toMatchObject({
      scope: "household",
    });

    const householdDefault = await shared.add({
      type: "reference",
      title: "Household utility",
      tags: [],
      body: "Shared utility note.\n",
    });
    expect(householdDefault).toMatchObject({ scope: "household" });
    expect(householdDefault).not.toHaveProperty("owner");
  });

  it("previews legacy unscoped notes only to Isaac for explicit revision-checked migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-memory-legacy-scope-"));
    const id = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(root, "preferences"), { mode: 0o700 });
    await writeFile(
      join(root, "preferences", `${id}.md`),
      `---\nschema: 1\nid: "${id}"\ntype: "preference"\nstatus: "active"\ntitle: "Legacy private note"\ntags: []\ncreated: "2026-07-19T03:30:00.000Z"\nupdated: "2026-07-19T03:30:00.000Z"\n---\nPrivate legacy fact.\n`,
      { mode: 0o600 },
    );

    const isaacReport = await lintMemoryVault({
      root,
      principal: "isaac",
      memoryView: "owner-and-household",
      sessionRoots: [join(root, "sessions")],
    });
    expect(isaacReport.warnings).toContainEqual({
      code: "LEGACY_SCOPE_UNMATERIALIZED",
      relativePath: join("preferences", `${id}.md`),
      affectsCore: false,
    });

    for (const view of [
      { principal: "emma", memoryView: "owner-and-household" },
      { principal: "household", memoryView: "household" },
      { principal: "engineering", memoryView: "none" },
    ]) {
      const report = await lintMemoryVault({
        root,
        ...view,
        sessionRoots: [join(root, "sessions")],
      });
      expect(report.warnings).not.toContainEqual(
        expect.objectContaining({ code: "LEGACY_SCOPE_UNMATERIALIZED" }),
      );
    }

    const isaac = createMarkdownMemoryStore({
      root,
      principal: "isaac",
      memoryView: "owner-and-household",
    });
    const legacy = await isaac.read({ id });
    const migrated = await isaac.update({
      id,
      ifRevision: legacy.revision,
      patch: { scope: "personal" },
    });
    expect(migrated).toMatchObject({ scope: "personal", owner: "isaac" });
    expect(
      (await lintMemoryVault({
        root,
        principal: "isaac",
        memoryView: "owner-and-household",
        sessionRoots: [join(root, "sessions")],
      })).warnings,
    ).not.toContainEqual(
      expect.objectContaining({ code: "LEGACY_SCOPE_UNMATERIALIZED" }),
    );
  });

  it("resolves visible provenance across instance session roots without returning session content", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-memory-fleet-provenance-"));
    const isaacSessions = join(root, "state", "instances", "isaac", "sessions");
    const sharedSessions = join(root, "state", "instances", "shared", "sessions");
    await mkdir(isaacSessions, { recursive: true, mode: 0o700 });
    await mkdir(sharedSessions, { recursive: true, mode: 0o700 });
    const timestamp = "2026-07-19T03:30:00.000Z";
    await writeFile(
      join(sharedSessions, "2026-07-19T03-30-00-000Z_shared-session.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "shared-session",
          timestamp,
          cwd: "/srv/workspaces/shared",
        }),
        JSON.stringify({
          type: "message",
          id: "abcdef12",
          parentId: null,
          timestamp,
          message: { role: "user", content: "must not enter lint output" },
        }),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    const shared = createMarkdownMemoryStore({
      root,
      principal: "household",
      memoryView: "household",
    });
    await shared.add({
      type: "reference",
      title: "Household source",
      tags: [],
      body: `Household fact.[^source]\n\n[^source]: Pi session \`shared-session\`, entry \`abcdef12\`, \`${timestamp}\`.\n`,
    });

    const report = await lintMemoryVault({
      root,
      principal: "isaac",
      memoryView: "owner-and-household",
      sessionRoots: [isaacSessions, sharedSessions],
    });

    expect(report.valid).toBe(true);
    expect(JSON.stringify(report)).not.toContain("must not enter lint output");
  });
});
