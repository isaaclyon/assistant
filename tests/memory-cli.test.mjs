import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMemoryCli } from "../.pi/skills/personal-memory/scripts/memory.mjs";
import { commitMemoryMutation } from "../.pi/skills/personal-memory/scripts/git.mjs";

const execFileAsync = promisify(execFile);

function collector() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    },
  };
}

let vault;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "memory-cli-"));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function run(
  command,
  request,
  { raw, vaultDir = vault, cwd, stateDir, gitAutocommit = false, gitEnvironment = {} } = {},
) {
  const stdout = collector();
  const stderr = collector();
  const input = raw ?? (request === undefined ? "" : `${JSON.stringify(request)}\n`);
  const exitCode = await runMemoryCli({
    argv: command === undefined ? [] : [command],
    stdin: Readable.from(input === "" ? [] : [input]),
    stdout,
    stderr,
    env: {
      PI_TELEGRAM_MEMORY_DIR: vaultDir,
      ...(stateDir ? { PI_TELEGRAM_BRIDGE_STATE_DIR: stateDir } : {}),
      ...(gitAutocommit ? { PI_TELEGRAM_MEMORY_GIT_AUTOCOMMIT: "1" } : {}),
      ...gitEnvironment,
    },
    cwd: cwd ?? process.cwd(),
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

async function initializeGit(root = vault) {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Memory Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "memory@example.invalid"], { cwd: root });
}

async function gitLog(root = vault) {
  const { stdout } = await execFileAsync("git", ["log", "--format=%s"], { cwd: root });
  return stdout.trim().split("\n").filter(Boolean);
}

function parseLine(text) {
  const lines = text.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw new Error("Expected one JSON response line");
  }
}

async function addNote(overrides = {}) {
  const { exitCode, stdout } = await run("add", {
    type: "preference",
    title: "Synthetic beverage",
    tags: ["synthetic"],
    body: "Prefers synthetic tea.",
    ...overrides,
  });
  expect(exitCode).toBe(0);
  return parseLine(stdout).data;
}

describe("personal memory CLI", () => {
  it("serializes Git preflight, mutation, and commit across concurrent commands", async () => {
    await initializeGit();
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => run("add", {
      type: "reference", title: `Concurrent ${index}`, tags: [], body: "Synthetic",
    }, { gitAutocommit: true })));
    for (const result of results) {
      expect(result.exitCode, result.stderr).toBe(0);
      expect(parseLine(result.stdout).data.git).toEqual({ committed: true });
    }
    expect(await gitLog()).toHaveLength(4);
  });

  it("rejects a missing or unknown command with exit 2", async () => {
    for (const command of [undefined, "wipe"]) {
      const { exitCode, stdout, stderr } = await run(command, {});
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      const envelope = parseLine(stderr);
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        ok: false,
        error: { code: "INVALID_COMMAND" },
      });
    }
  });

  it("rejects empty, malformed, multi-line, and non-object input with exit 2", async () => {
    const cases = ["", "not json\n", '{"a":1}\n{"b":2}\n', "[1,2]\n"];
    for (const raw of cases) {
      const { exitCode, stdout, stderr } = await run("list", undefined, { raw });
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(parseLine(stderr).error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects an oversized request with exit 2", async () => {
    const raw = `{"query":"${"x".repeat(310 * 1024)}"}\n`;
    const { exitCode, stderr } = await run("search", undefined, { raw });
    expect(exitCode).toBe(2);
    expect(parseLine(stderr).error.code).toBe("INVALID_INPUT");
  });

  it("adds a note and emits one versioned success line on stdout", async () => {
    const { exitCode, stdout, stderr } = await run("add", {
      type: "preference",
      title: "Synthetic beverage",
      tags: ["synthetic"],
      body: "Prefers synthetic tea.",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const envelope = parseLine(stdout);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.title).toBe("Synthetic beverage");
    expect(envelope.data.relativePath).toBe(`preferences/${envelope.data.id}.md`);
    expect(envelope.data.body).toBeUndefined();
  });

  it("does not discover or invoke Git while auto-commit is disabled", async () => {
    const bin = join(vault, "bin");
    const marker = join(vault, "git-ran");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
      { mode: 0o700 },
    );

    const result = await run("add", {
      type: "preference",
      title: "Synthetic beverage",
      tags: [],
      body: "Prefers synthetic tea.",
    }, { gitEnvironment: { PATH: bin } });

    expect(result.exitCode).toBe(0);
    await expect(readdir(vault)).resolves.not.toContain("git-ran");
  });

  it("commits each enabled mutation locally without including unrelated files", async () => {
    await initializeGit();
    await writeFile(join(vault, "tracked-draft.md"), "original\n");
    await execFileAsync("git", ["add", "--", "tracked-draft.md"], { cwd: vault });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: vault });
    await writeFile(join(vault, "tracked-draft.md"), "edited outside memory CLI\n");
    await execFileAsync("git", ["config", "commit.gpgsign", "true"], { cwd: vault });
    await execFileAsync("git", ["config", "gpg.program", "/path/that/does/not/exist"], { cwd: vault });
    const hookMarker = join(vault, "post-commit-ran");
    const hook = join(vault, ".git", "hooks", "post-commit");
    await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\n`, { mode: 0o700 });
    const prepareHookMarker = join(vault, "prepare-commit-msg-ran");
    const prepareHook = join(vault, ".git", "hooks", "prepare-commit-msg");
    await writeFile(
      prepareHook,
      `#!/bin/sh\ntouch ${JSON.stringify(prepareHookMarker)}\n`,
      { mode: 0o700 },
    );
    await writeFile(join(vault, "private-draft.md"), "not part of the managed mutation\n");

    const addedResult = await run("add", {
      type: "preference",
      title: "Synthetic beverage",
      tags: ["synthetic"],
      body: "Prefers synthetic tea.",
    }, { gitAutocommit: true });
    expect(addedResult.exitCode).toBe(0);
    const added = parseLine(addedResult.stdout).data;
    expect(added.git).toEqual({ committed: true });

    const updatedResult = await run("update", {
      id: added.id,
      ifRevision: added.revision,
      patch: { body: "Prefers synthetic coffee.", scope: "household" },
    }, { gitAutocommit: true });
    const updated = parseLine(updatedResult.stdout).data;
    expect(updated.git).toEqual({ committed: true });
    expect(updated).toMatchObject({ scope: "household" });
    expect(updated).not.toHaveProperty("owner");

    const happeningResult = await run("happening-add", {
      id: added.id,
      ifRevision: updated.revision,
      date: "2026-07-20",
      text: "Tried synthetic coffee.",
    }, { gitAutocommit: true });
    const happened = parseLine(happeningResult.stdout).data;
    expect(happened.git).toEqual({ committed: true });

    const deletedResult = await run("delete", {
      id: added.id,
      ifRevision: happened.revision,
      confirmId: added.id,
    }, { gitAutocommit: true });
    expect(parseLine(deletedResult.stdout).data).toEqual({
      id: added.id,
      deleted: true,
      git: { committed: true },
    });
    expect(await gitLog()).toEqual([
      `memory: delete ${added.id}`,
      `memory: update ${added.id}`,
      `memory: update ${added.id}`,
      `memory: add ${added.id}`,
      "initial",
    ]);
    const { stdout: status } = await execFileAsync("git", ["status", "--short"], { cwd: vault });
    expect(status).toBe(" M tracked-draft.md\n?? .mutation-lock.sqlite\n?? private-draft.md\n");
    await expect(readdir(vault)).resolves.not.toContain("post-commit-ran");
    await expect(readdir(vault)).resolves.not.toContain("prepare-commit-msg-ran");
  });

  it("ignores inherited Git repository and index routing variables", async () => {
    await initializeGit();
    const alternate = await mkdtemp(join(tmpdir(), "memory-alternate-git-"));
    await initializeGit(alternate);
    await writeFile(join(alternate, "staged.md"), "staged elsewhere\n");
    await execFileAsync("git", ["add", "--", "staged.md"], { cwd: alternate });
    try {
      const result = await run("add", {
        type: "preference",
        title: "Synthetic beverage",
        tags: [],
        body: "Prefers synthetic tea.",
      }, {
        gitAutocommit: true,
        gitEnvironment: {
          GIT_DIR: join(alternate, ".git"),
          GIT_WORK_TREE: alternate,
          GIT_INDEX_FILE: join(alternate, ".git", "index"),
        },
      });
      expect(result.exitCode).toBe(0);
      expect(parseLine(result.stdout).data.git).toEqual({ committed: true });
      expect(await gitLog()).toHaveLength(1);
      const { stdout: alternateStatus } = await execFileAsync(
        "git",
        ["status", "--short"],
        { cwd: alternate },
      );
      expect(alternateStatus).toBe("A  staged.md\n");
    } finally {
      await rm(alternate, { recursive: true, force: true });
    }
  });

  it("requires the configured vault to be the exact Git worktree root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "memory-parent-git-"));
    const nestedVault = join(parent, "memory");
    await mkdir(nestedVault);
    await initializeGit(parent);
    try {
      const result = await run("add", {
        type: "preference",
        title: "Synthetic beverage",
        tags: [],
        body: "Prefers synthetic tea.",
      }, { vaultDir: nestedVault, gitAutocommit: true });
      expect(result.exitCode).toBe(3);
      expect(parseLine(result.stderr).error).toEqual({
        code: "GIT_AUTOCOMMIT_UNAVAILABLE",
        message: "Memory Git auto-commit is unavailable",
      });
      // Lock metadata is not a canonical mutation and contains no note data.
      expect(await readdir(nestedVault)).toEqual([".mutation-lock.sqlite"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses an enabled mutation while the Git index contains staged changes", async () => {
    await initializeGit();
    await writeFile(join(vault, "staged.md"), "staged\n");
    await execFileAsync("git", ["add", "--", "staged.md"], { cwd: vault });
    const alternateIndex = join(vault, ".git", "alternate-index");
    await execFileAsync("git", ["read-tree", "--empty"], {
      cwd: vault,
      env: { ...process.env, GIT_INDEX_FILE: alternateIndex },
    });

    const result = await run("add", {
      type: "preference",
      title: "Synthetic beverage",
      tags: [],
      body: "Prefers synthetic tea.",
    }, {
      gitAutocommit: true,
      gitEnvironment: { GIT_INDEX_FILE: alternateIndex },
    });

    expect(result.exitCode).toBe(3);
    expect(parseLine(result.stderr).error.code).toBe("GIT_AUTOCOMMIT_UNAVAILABLE");
    expect(await readdir(vault)).toEqual(expect.not.arrayContaining(["preferences"]));
  });

  it("preserves delete validation ordering when Git auto-commit is enabled", async () => {
    await initializeGit();
    const result = await run("delete", {
      id: "2f5f167d-7a18-4457-8de7-f2f801f1e934",
    }, { gitAutocommit: true });
    expect(result.exitCode).toBe(3);
    expect(parseLine(result.stderr).error.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("reports post-write Git failure without disguising a persisted mutation as a failure", async () => {
    await initializeGit();
    await execFileAsync("git", ["config", "user.name", ""], { cwd: vault });
    await execFileAsync("git", ["config", "user.email", ""], { cwd: vault });

    const result = await run("add", {
      type: "preference",
      title: "Synthetic beverage",
      tags: [],
      body: "Prefers synthetic tea.",
    }, { gitAutocommit: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const data = parseLine(result.stdout).data;
    expect(data.git).toEqual({ committed: false, code: "GIT_COMMIT_FAILED" });
    expect(await readdir(join(vault, "preferences"))).toEqual([`${data.id}.md`]);
  });

  it("bounds Git execution that stalls after a memory mutation", async () => {
    const bin = join(vault, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o700 });
    const started = Date.now();

    const result = await commitMemoryMutation(
      vault,
      {
        action: "update",
        id: "2f5f167d-7a18-4457-8de7-f2f801f1e934",
        relativePath: "preferences/2f5f167d-7a18-4457-8de7-f2f801f1e934.md",
      },
      { env: { ...process.env, PATH: bin }, timeoutMs: 25 },
    );

    expect(result).toEqual({ committed: false, code: "GIT_COMMIT_FAILED" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reads a note back including its body", async () => {
    const added = await addNote();
    const { exitCode, stdout } = await run("read", { id: added.id });
    expect(exitCode).toBe(0);
    expect(parseLine(stdout).data.body).toBe("Prefers synthetic tea.");
  });

  it("returns NOT_FOUND with exit 3 for a missing note", async () => {
    const { exitCode, stderr } = await run("read", {
      id: "2f5f167d-7a18-4457-8de7-f2f801f1e934",
    });
    expect(exitCode).toBe(3);
    expect(parseLine(stderr).error.code).toBe("NOT_FOUND");
  });

  it("updates with the current revision and rejects a stale one with exit 3", async () => {
    const added = await addNote();
    const ok = await run("update", {
      id: added.id,
      ifRevision: added.revision,
      patch: { body: "Prefers synthetic coffee." },
    });
    expect(ok.exitCode).toBe(0);
    expect(parseLine(ok.stdout).data.body).toBe("Prefers synthetic coffee.");

    const stale = await run("update", {
      id: added.id,
      ifRevision: added.revision,
      patch: { body: "Prefers water." },
    });
    expect(stale.exitCode).toBe(3);
    expect(parseLine(stale.stderr).error.code).toBe("REVISION_CONFLICT");
  });

  it("requires delete confirmation and then removes the note", async () => {
    const added = await addNote();
    const unconfirmed = await run("delete", {
      id: added.id,
      ifRevision: added.revision,
    });
    expect(unconfirmed.exitCode).toBe(3);
    expect(parseLine(unconfirmed.stderr).error.code).toBe("CONFIRMATION_REQUIRED");

    const confirmed = await run("delete", {
      id: added.id,
      ifRevision: added.revision,
      confirmId: added.id,
    });
    expect(confirmed.exitCode).toBe(0);
    expect(parseLine(confirmed.stdout).data).toEqual({ id: added.id, deleted: true });
    expect(await readdir(join(vault, "preferences"))).toEqual([]);
  });

  it("lists and searches stored notes", async () => {
    const added = await addNote();
    const listed = await run("list", {});
    expect(listed.exitCode).toBe(0);
    expect(parseLine(listed.stdout).data.memories.map((note) => note.id)).toEqual([
      added.id,
    ]);

    const searched = await run("search", { query: "synthetic tea", limit: 5 });
    expect(searched.exitCode).toBe(0);
    const { results, truncated, warnings } = parseLine(searched.stdout).data;
    expect(results.map((result) => result.id)).toEqual([added.id]);
    expect(results[0].snippet).toContain("synthetic tea");
    expect(truncated).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("updates status and requires explicit filters to recall inactive notes", async () => {
    const added = await addNote();
    const updated = await run("update", {
      id: added.id,
      ifRevision: added.revision,
      patch: { status: "archived" },
    });
    expect(updated.exitCode).toBe(0);
    expect(parseLine(updated.stdout).data.status).toBe("archived");

    expect(parseLine((await run("list", {})).stdout).data.memories).toEqual([]);
    expect(parseLine((await run("search", { query: "synthetic" })).stdout).data.results).toEqual([]);
    expect(parseLine((await run("list", { statuses: ["archived"] })).stdout).data.memories).toEqual([
      expect.objectContaining({ id: added.id, status: "archived" }),
    ]);
    expect(
      parseLine((await run("search", { query: "synthetic", statuses: ["archived"] })).stdout).data.results,
    ).toEqual([expect.objectContaining({ id: added.id, status: "archived" })]);
  });

  it("returns the exact core projection through the CLI", async () => {
    await addNote({ body: "Prefers synthetic tea. #core" });

    const result = await run("core", {});

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseLine(result.stdout).data).toMatchObject({
      text: expect.stringContaining("- Synthetic beverage: Prefers synthetic tea."),
      characters: expect.any(Number),
      budget: 4_000,
      warning: false,
    });
  });

  it("emits a complete lint report on stdout and exits 3 when invalid", async () => {
    await addNote({ body: "Related: [[Missing title]]" });

    const result = await run("lint", {});

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(parseLine(result.stdout)).toMatchObject({
      ok: true,
      data: {
        valid: false,
        errors: [expect.objectContaining({ code: "INVALID_LINK", affectsCore: false })],
        core: { valid: true },
      },
    });
  });

  it("validates source footnotes against the configured bridge session directory", async () => {
    const timestamp = "2026-07-19T03:30:00.000Z";
    const stateDir = join(vault, "bridge-state");
    const sessionDir = join(stateDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "2026-07-19T03-30-00-000Z_session-1.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd: "/repo" }),
        JSON.stringify({ type: "message", id: "abcdef12", parentId: null, timestamp, message: {} }),
      ].join("\n") + "\n",
    );
    await addNote({
      body: `Sourced fact.[^source]\n\n[^source]: Pi session \`session-1\`, entry \`abcdef12\`, \`${timestamp}\`.`,
    });

    const result = await run("lint", {}, { stateDir });

    expect(result.exitCode).toBe(0);
    expect(parseLine(result.stdout).data.valid).toBe(true);
  });

  it("adds dated happenings to an entity note in chronological order", async () => {
    const added = await addNote({ type: "reference", title: "Tesla Model Y Pearl", body: "Our car.\n" });

    const later = await run("happening-add", {
      id: added.id,
      ifRevision: added.revision,
      date: "2026-07-19",
      text: "Pearl got new tires.",
    });
    expect(later.exitCode).toBe(0);
    const laterData = parseLine(later.stdout).data;
    expect(laterData.happening).toEqual({ date: "2026-07-19", text: "Pearl got new tires." });

    const earlier = await run("happening-add", {
      id: added.id,
      ifRevision: laterData.revision,
      date: "2026-06-01",
      text: "Pearl entered our household.",
    });
    expect(earlier.exitCode).toBe(0);
    expect(parseLine(earlier.stdout).data.body).toBe(
      "Our car.\n\n## Happenings\n\n- 2026-06-01 — Pearl entered our household.\n- 2026-07-19 — Pearl got new tires.\n",
    );
  });

  it("queries happenings globally with date and text filters", async () => {
    const pearl = await addNote({ type: "reference", title: "Tesla Model Y Pearl", body: "Our car." });
    const home = await addNote({ type: "reference", title: "Home", body: "Our home." });
    const pearlAdded = await run("happening-add", {
      id: pearl.id,
      ifRevision: pearl.revision,
      date: "2026-07-19",
      text: "Pearl got new tires.",
    });
    const homeAdded = await run("happening-add", {
      id: home.id,
      ifRevision: home.revision,
      date: "2024-06-01",
      text: "Emma and Isaac moved out.",
    });
    expect(pearlAdded.exitCode).toBe(0);
    expect(homeAdded.exitCode).toBe(0);

    const queried = await run("happenings", {
      from: "2026-01-01",
      to: "2026-12-31",
      query: "tires",
    });
    expect(queried.exitCode).toBe(0);
    expect(parseLine(queried.stdout).data).toMatchObject({
      results: [{
        id: pearl.id,
        title: "Tesla Model Y Pearl",
        date: "2026-07-19",
        text: "Pearl got new tires.",
      }],
      truncated: false,
      warnings: [],
    });
  });

  it("rejects duplicate and invalid happenings", async () => {
    const added = await addNote({ type: "reference", title: "Pearl", body: "Our car." });
    const request = {
      id: added.id,
      ifRevision: added.revision,
      date: "2026-07-19",
      text: "Got new tires.",
    };
    const first = await run("happening-add", request);
    expect(first.exitCode).toBe(0);

    const duplicate = await run("happening-add", {
      ...request,
      ifRevision: parseLine(first.stdout).data.revision,
    });
    expect(duplicate.exitCode).toBe(3);
    expect(parseLine(duplicate.stderr).error.code).toBe("DUPLICATE_HAPPENING");

    const invalid = await run("happening-add", {
      ...request,
      ifRevision: parseLine(first.stdout).data.revision,
      date: "2026-02-30",
    });
    expect(invalid.exitCode).toBe(2);
    expect(parseLine(invalid.stderr).error.code).toBe("INVALID_INPUT");
  });

  it("refuses a symlinked vault root that resolves into a forbidden root", async () => {
    const linkPath = join(vault, "vault-link");
    await symlink(process.cwd(), linkPath);
    for (const command of ["search", "read", "lint", "core"]) {
      let request = {};
      if (command === "search") request = { query: "synthetic" };
      else if (command === "read") request = { id: "2f5f167d-7a18-4457-8de7-f2f801f1e934" };
      const { exitCode, stdout, stderr } = await run(
        command,
        request,
        { vaultDir: linkPath },
      );
      expect(exitCode).toBe(3);
      expect(stdout).toBe("");
      const envelope = parseLine(stderr);
      expect(envelope.error.code).toBe("UNSAFE_VAULT");
      expect(envelope.error.message).not.toContain(linkPath);
    }
  });

  it("refuses a vault inside a forbidden root with a sanitized exit-3 error", async () => {
    const forbidden = join(process.cwd(), "tmp-memory-vault");
    for (const command of ["add", "search"]) {
      const { exitCode, stdout, stderr } = await run(
        command,
        command === "add"
          ? { type: "preference", title: "Synthetic", tags: [], body: "x" }
          : { query: "synthetic" },
        { vaultDir: forbidden },
      );
      expect(exitCode).toBe(3);
      expect(stdout).toBe("");
      const envelope = parseLine(stderr);
      expect(envelope.error.code).toBe("UNSAFE_VAULT");
      expect(envelope.error.message).not.toContain(forbidden);
    }
  });
});
