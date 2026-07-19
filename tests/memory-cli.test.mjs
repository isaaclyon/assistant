import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMemoryCli } from "../.pi/skills/personal-memory/scripts/memory.mjs";

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

async function run(command, request, { raw, vaultDir = vault, cwd } = {}) {
  const stdout = collector();
  const stderr = collector();
  const input = raw ?? (request === undefined ? "" : `${JSON.stringify(request)}\n`);
  const exitCode = await runMemoryCli({
    argv: command === undefined ? [] : [command],
    stdin: Readable.from(input === "" ? [] : [input]),
    stdout,
    stderr,
    env: { PI_TELEGRAM_MEMORY_DIR: vaultDir },
    cwd: cwd ?? process.cwd(),
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

function parseLine(text) {
  const lines = text.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0]);
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
    for (const command of ["search", "read"]) {
      const { exitCode, stdout, stderr } = await run(
        command,
        command === "search"
          ? { query: "synthetic" }
          : { id: "2f5f167d-7a18-4457-8de7-f2f801f1e934" },
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
