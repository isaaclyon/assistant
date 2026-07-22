import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { migrateLegacyStateToInstance } from "../src/state-migration.js";

describe("legacy instance-state migration", () => {
  it("atomically copies every known singleton state surface to Isaac and retains rollback source", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-state-migration-"));
    await mkdir(join(stateRoot, "sessions"));
    await mkdir(join(stateRoot, "checkers"));
    await writeFile(join(stateRoot, "sessions", "session.jsonl"), "session\n");
    await writeFile(join(stateRoot, "checkers", "weather.json"), "{}\n");
    for (const [name, content] of [
      ["inbox.db", "sqlite"],
      ["inbox.db-wal", "wal"],
      ["inbox.db-shm", "shm"],
      ["pi-codex-conversion.json", "{}\n"],
      ["restart-pending.json", ""],
      ["jobs.json", "{}\n"],
      ["jobs-state.json", "{}\n"],
    ] as const) {
      await writeFile(join(stateRoot, name), content);
    }

    const result = await migrateLegacyStateToInstance({
      stateRoot,
      instanceId: "isaac",
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });

    const destination = join(stateRoot, "instances", "isaac");
    expect(result).toEqual({
      source: stateRoot,
      destination,
      copiedEntries: [
        "checkers",
        "inbox.db",
        "inbox.db-shm",
        "inbox.db-wal",
        "jobs-state.json",
        "jobs.json",
        "pi-codex-conversion.json",
        "restart-pending.json",
        "sessions",
      ],
    });
    await expect(
      readFile(join(destination, "sessions", "session.jsonl"), "utf8"),
    ).resolves.toBe("session\n");
    await expect(readFile(join(destination, "inbox.db-wal"), "utf8")).resolves.toBe(
      "wal",
    );
    await expect(readFile(join(stateRoot, "inbox.db"), "utf8")).resolves.toBe(
      "sqlite",
    );
    await expect(readFile(join(destination, "migration.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          version: 1,
          source: stateRoot,
          instanceId: "isaac",
          migratedAt: "2026-07-21T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination, "inbox.db"))).mode & 0o777).toBe(0o600);
  });

  it("fails closed on unknown legacy state without creating a destination", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-state-ambiguous-"));
    await writeFile(join(stateRoot, "mystery.db"), "unknown");

    await expect(
      migrateLegacyStateToInstance({ stateRoot, instanceId: "isaac" }),
    ).rejects.toThrow(/unknown legacy state.*mystery\.db/i);
    await expect(stat(join(stateRoot, "instances", "isaac"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to overwrite or merge an existing instance destination", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bridge-state-existing-"));
    await mkdir(join(stateRoot, "instances", "isaac"), { recursive: true });

    await expect(
      migrateLegacyStateToInstance({ stateRoot, instanceId: "isaac" }),
    ).rejects.toThrow(/destination already exists/i);
  });
});
