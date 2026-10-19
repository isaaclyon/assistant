import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type NativeCoordinatorConfig, type NativeJobsCoordinator, startNativeJobsCoordinator } from "../../src/durable/coordinator.js";
import { openJobOccurrenceLedger } from "../../src/job-occurrences.js";
import { cancelJobHandoff, enqueueJobHandoff } from "../../src/job-handoff.js";
import { parseJobsFile, startJobScheduler } from "../../src/jobs.js";

const NOW = Date.parse("2023-11-14T22:13:20.000Z");
const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

async function layout(instances = ["isaac", "emma", "shared"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-coordinator-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const coordinatorStateDir = join(root, "coordinator");
  for (const dir of [stateRoot, join(stateRoot, "instances"), coordinatorStateDir,
    ...instances.map((id) => join(stateRoot, "instances", id))]) {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
  }
  return { stateRoot, coordinatorStateDir, dir: (id: string) => join(stateRoot, "instances", id) };
}

async function writeJobs(stateDir: string, jobs: unknown[]): Promise<void> {
  await writeFile(join(stateDir, "jobs.json"), `${JSON.stringify({ version: 3, jobs })}\n`, { mode: 0o600 });
}

const atJob = (over: Record<string, unknown> = {}) => ({
  id: "reminder", type: "at", at: "2023-11-14T00:00:00Z", prompt: "Call the dentist", target: "emma", ...over,
});

async function start(
  l: Awaited<ReturnType<typeof layout>>,
  self = "isaac",
  coordinator: Partial<NativeCoordinatorConfig> = {},
  options: Partial<Parameters<typeof startNativeJobsCoordinator>[1]> = {},
): Promise<NativeJobsCoordinator> {
  const c = await startNativeJobsCoordinator(
    {
      instanceId: self,
      stateDir: l.dir(self),
      coordinator: {
        stateRoot: l.stateRoot, coordinatorStateDir: l.coordinatorStateDir,
        targets: ["isaac", "emma", "shared"], scope: "shared-owner", ...coordinator,
      },
    },
    { logger: logs, nowMs: () => NOW, ...options },
  );
  cleanups.push(() => c.stop());
  return c;
}

const pending = async (l: Awaited<ReturnType<typeof layout>>, id: string, state = "pending") =>
  readdir(join(l.dir(id), "job-handoffs", state)).catch(() => [] as string[]);

describe("native jobs coordinator", () => {
  it("retries a late at-job with stable IDs and the first materialization time", async () => {
    const l = await layout();
    await writeJobs(l.coordinatorStateDir, [atJob()]);
    let now = NOW;
    let fail = true;
    const enqueue = vi.fn(async (o: Parameters<typeof enqueueJobHandoff>[0]) => {
      if (fail) throw new Error("injected");
      return enqueueJobHandoff(o);
    });
    const c = await start(l, "isaac", {}, { nowMs: () => now, publication: { enqueue, cancel: cancelJobHandoff } });
    await c.tick();
    expect(await pending(l, "emma")).toEqual([]);
    fail = false;
    now += 3_600_000;
    await c.tick();
    const names = await pending(l, "emma");
    expect(names).toHaveLength(1);
    const handoff = JSON.parse(await readFile(join(l.dir("emma"), "job-handoffs/pending", names[0]!), "utf8"));
    expect(handoff).toMatchObject({ jobId: "reminder", jobType: "at", target: "emma", createdAt: new Date(NOW).toISOString() });
    expect(names[0]).toMatch(/^reminder-[a-f0-9]{64}\.json$/);
    expect(enqueue.mock.calls.at(-1)![0].now!().getTime()).toBe(NOW);
    // Restart and repeated ticks add nothing.
    await c.stop();
    const again = await start(l);
    await again.tick();
    await again.tick();
    expect(await pending(l, "emma")).toEqual(names);
  });

  it("retries an escaped prompt after publication acknowledgement is lost", async () => {
    const l = await layout();
    await writeJobs(l.coordinatorStateDir, [atJob({ prompt: "\u0001".repeat(8_000) })]);
    let acknowledged = false;
    const enqueue = vi.fn(async (o: Parameters<typeof enqueueJobHandoff>[0]) => {
      const result = await enqueueJobHandoff(o);
      if (!acknowledged) throw new Error("Lost acknowledgement");
      return result;
    });
    const c = await start(l, "isaac", {}, { publication: { enqueue, cancel: cancelJobHandoff } });
    await c.tick();
    expect(await pending(l, "emma")).toHaveLength(1);
    acknowledged = true;
    await c.tick();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(await pending(l, "emma")).toHaveLength(1);
    const ledger = openJobOccurrenceLedger(l.coordinatorStateDir);
    expect(ledger.pending()).toEqual([]);
    ledger.close();
  });

  it("fires cron slots and publishes both-personal to both explicit targets", async () => {
    const l = await layout();
    await writeJobs(l.coordinatorStateDir, [{ id: "minute", type: "cron", schedule: "* * * * *", tz: "UTC", prompt: "Stretch", target: "both-personal" }]);
    let now = NOW;
    const c = await start(l, "isaac", {}, { nowMs: () => now });
    now += 61_000;
    await c.tick();
    expect(await pending(l, "isaac")).toHaveLength(1);
    expect(await pending(l, "emma")).toHaveLength(1);
    expect(await pending(l, "shared")).toEqual([]);
  });

  it("rejects unsupported declared types before reconciliation and keeps the last good jobs", async () => {
    const l = await layout();
    await writeJobs(l.coordinatorStateDir, [atJob({ at: "2999-01-01T00:00:00Z" })]);
    const c = await start(l);
    expect(c.getJobs().map((job) => job.id)).toEqual(["reminder"]);
    await writeJobs(l.coordinatorStateDir, [atJob({ at: "2999-01-01T00:00:00Z" }),
      { id: "hook", type: "webhook", prompt: "x", target: "isaac" }]);
    await c.reload();
    expect(c.getJobs().map((job) => job.id)).toEqual(["reminder"]);
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('job type "webhook" is not supported'));
    const ledger = openJobOccurrenceLedger(l.coordinatorStateDir);
    expect(ledger.pending()).toEqual([]);
    ledger.close();
  });

  it("restarts after a first invalid definition file, then publishes a corrected reminder", async () => {
    const l = await layout();
    await writeJobs(l.coordinatorStateDir, [{ id: "unsupported", type: "webhook", prompt: "x", target: "emma" }]);
    const first = await start(l);
    expect(first.getJobs()).toEqual([]);
    expect(JSON.parse(await readFile(join(l.coordinatorStateDir, "jobs-state.json"), "utf8")).lastLoadError).toContain("not supported");
    await first.stop();
    const restarted = await start(l);
    expect(restarted.getJobs()).toEqual([]);
    await writeJobs(l.coordinatorStateDir, [atJob()]);
    await restarted.reload();
    await restarted.tick();
    expect(await pending(l, "emma")).toHaveLength(1);
  });

  it("holds a restored unsupported occurrence as pending", async () => {
    const l = await layout();
    const hook = { id: "hook", type: "webhook" as const, prompt: "x", target: "isaac" };
    await writeJobs(l.coordinatorStateDir, [hook]);
    const seeded = openJobOccurrenceLedger(l.coordinatorStateDir);
    seeded.reconcileDefinitions([hook], {});
    const occurrence = seeded.materialize(hook, "webhook:hook:1", "payload", NOW);
    seeded.close();
    const c = await start(l);
    await c.tick();
    expect(await pending(l, "isaac")).toEqual([]);
    const ledger = openJobOccurrenceLedger(l.coordinatorStateDir);
    expect(ledger.pending().map((o) => o.id)).toEqual([occurrence.id]);
    ledger.close();
  });

  it("keeps legacy parser and scheduler defaults", async () => {
    const raw = JSON.stringify({ version: 3, jobs: [{ id: "hook", type: "webhook", prompt: "x", target: "isaac" }] });
    expect(parseJobsFile(raw)).toHaveLength(1);
    expect(() => parseJobsFile(raw, { allowedTypes: new Set(["cron", "at"]) })).toThrow(/not supported/);
    const l = await layout();
    await writeJobs(l.coordinatorStateDir, [{ id: "hook", type: "webhook", prompt: "x", target: "isaac" }]);
    const scheduler = await startJobScheduler({
      stateDir: l.coordinatorStateDir, webhookHost: "127.0.0.1", webhookPort: 0, inject: async () => {}, logger: logs,
    });
    expect(scheduler.getJobs()).toHaveLength(1);
    await scheduler.stop();
  });

  describe("authority", () => {
    it("rejects invalid direct construction", async () => {
      const l = await layout();
      const attempt = (coordinator: Partial<NativeCoordinatorConfig>, self = "isaac", stateDir = l.dir(self)) =>
        startNativeJobsCoordinator({
          instanceId: self, stateDir,
          coordinator: { stateRoot: l.stateRoot, coordinatorStateDir: l.coordinatorStateDir, targets: ["isaac", "emma"], scope: "shared-owner", ...coordinator },
        }, { logger: logs });
      await expect(attempt({ targets: ["isaac", "isaac"] })).rejects.toThrow(/unique/);
      await expect(attempt({ targets: ["Bad/../id"] })).rejects.toThrow(/stable instance IDs/);
      await expect(attempt({ targets: ["both-personal"] })).rejects.toThrow(/stable instance IDs/);
      await expect(attempt({ scope: "self", targets: ["isaac", "emma"] })).rejects.toThrow(/exactly its own/);
      await expect(attempt({ scope: "self", targets: ["emma"] })).rejects.toThrow(/exactly its own/);
      await expect(attempt({}, "isaac", l.dir("emma"))).rejects.toThrow(/stateRoot\/instances/);
      await expect(attempt({ coordinatorStateDir: l.dir("emma") })).rejects.toThrow(/distinct/);
      await expect(attempt({ coordinatorStateDir: l.dir("isaac") })).rejects.toThrow(/distinct/);
      await expect(attempt({ coordinatorStateDir: join(l.dir("isaac"), "coordinator") })).rejects.toThrow(/distinct/);
      await expect(attempt({ coordinatorStateDir: join(l.dir("emma"), "coordinator") })).rejects.toThrow(/distinct/);
      await chmod(l.coordinatorStateDir, 0o755);
      await expect(attempt({})).rejects.toThrow(/private, owned directory/);
    });

    it("rejects out-of-scope targets at load and holds out-of-authority work", async () => {
      const l = await layout();
      await writeJobs(l.coordinatorStateDir, [atJob({ target: "emma" })]);
      const self = await start(l, "isaac", { scope: "self", targets: ["isaac"] });
      expect(self.getJobs()).toEqual([]);
      expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('unknown target "emma"'));
      await self.stop();
      await writeJobs(l.coordinatorStateDir, [atJob({ target: "both-personal" })]);
      const partial = await start(l, "isaac", { targets: ["isaac", "shared"] });
      expect(partial.getJobs()).toEqual([]);
      expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('target "both-personal" requires'));
      expect(await pending(l, "emma")).toEqual([]);
    });

    it.each(["pending", "superseded"])("holds corrupt %s occurrence identities before publication or cancellation", async (status) => {
      const l = await layout();
      const job = atJob({ at: "2999-01-01T00:00:00Z" }) as Parameters<ReturnType<typeof openJobOccurrenceLedger>["materialize"]>[0];
      await writeJobs(l.coordinatorStateDir, [job]);
      const ledger = openJobOccurrenceLedger(l.coordinatorStateDir);
      ledger.reconcileDefinitions([job], {});
      ledger.materialize(job, "at:reminder", "Synthetic reminder", NOW);
      ledger.close();
      const db = new DatabaseSync(join(l.coordinatorStateDir, "job-occurrences.db"));
      db.prepare("UPDATE occurrence SET id = ?, status = ?, job_id = ?").run("../../../escape", status, status === "pending" ? job.id : "../escape");
      db.close();
      const enqueue = vi.fn(enqueueJobHandoff), cancel = vi.fn(cancelJobHandoff);
      const attempt = () => start(l, "isaac", {}, { publication: { enqueue, cancel } });
      if (status === "superseded") await expect(attempt()).rejects.toThrow(/identity is incomplete/);
      else await (await attempt()).tick();
      expect(enqueue).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(await pending(l, "emma")).toEqual([]);
      expect(await readdir(l.stateRoot)).toEqual(["instances"]);
    });

    it("holds the occurrence when a recipient path is a symlink", async () => {
      const l = await layout();
      const elsewhere = join(l.stateRoot, "elsewhere");
      await mkdir(elsewhere, { mode: 0o700 });
      await rm(l.dir("emma"), { recursive: true });
      await symlink(elsewhere, l.dir("emma"));
      await writeJobs(l.coordinatorStateDir, [atJob()]);
      const c = await start(l);
      await c.tick();
      expect(await readdir(elsewhere)).toEqual([]);
      expect(await readdir(join(l.coordinatorStateDir))).not.toContain("job-dispatches");
      const ledger = openJobOccurrenceLedger(l.coordinatorStateDir);
      expect(ledger.pending()).toHaveLength(1);
      ledger.close();
    });

    it("holds on a wrong mode or foreign-looking handoff entries, then publishes once fixed", async () => {
      const l = await layout();
      await chmod(l.dir("emma"), 0o755);
      await writeJobs(l.coordinatorStateDir, [atJob()]);
      const c = await start(l);
      await c.tick();
      expect(await pending(l, "emma")).toEqual([]);
      await chmod(l.dir("emma"), 0o700);
      await mkdir(join(l.dir("emma"), "job-handoffs/pending"), { recursive: true, mode: 0o700 });
      await chmod(join(l.dir("emma"), "job-handoffs/pending"), 0o755);
      await c.tick();
      expect(await pending(l, "emma")).toEqual([]);
      await chmod(join(l.dir("emma"), "job-handoffs/pending"), 0o700);
      await c.tick();
      expect(await pending(l, "emma")).toHaveLength(1);
    });

    it("does not publish to any recipient when one of both-personal is unsafe", async () => {
      const l = await layout();
      await chmod(l.dir("emma"), 0o755);
      await writeJobs(l.coordinatorStateDir, [atJob({ target: "both-personal" })]);
      const c = await start(l);
      await c.tick();
      expect(await pending(l, "isaac")).toEqual([]);
      const ledger = openJobOccurrenceLedger(l.coordinatorStateDir);
      expect(ledger.pending()).toHaveLength(1);
      ledger.close();
    });

    it("rejects a second native coordinator and allows one after stop", async () => {
      const l = await layout();
      const first = await start(l);
      await expect(start(l)).rejects.toThrow(/holds this coordinator state/);
      await first.stop();
      await (await start(l)).stop();
      expect((await lstat(join(l.coordinatorStateDir, "native-jobs-coordinator.lock.db"))).mode & 0o777).toBe(0o600);
    });
  });

  describe("cancellation", () => {
    it("cancels an unclaimed handoff when the definition changes", async () => {
      const l = await layout();
      await writeJobs(l.coordinatorStateDir, [atJob()]);
      const c = await start(l);
      await c.tick();
      const [name] = await pending(l, "emma");
      await writeJobs(l.coordinatorStateDir, [atJob({ prompt: "Call the other dentist", at: "2999-01-01T00:00:00Z" })]);
      await c.reload();
      expect(await pending(l, "emma")).toEqual([]);
      expect(await pending(l, "emma", "cancelled")).toEqual([name]);
    });

    it("holds startup after a target grant is removed and recovers when restored", async () => {
      const l = await layout();
      await writeJobs(l.coordinatorStateDir, [atJob()]);
      const first = await start(l);
      await first.tick();
      await first.stop();
      await writeJobs(l.coordinatorStateDir, []);
      await expect(start(l, "isaac", { scope: "self", targets: ["isaac"] })).rejects.toThrow(/outside this coordinator/);
      expect(await pending(l, "emma")).toHaveLength(1);
      const restored = await start(l);
      await restored.tick();
      expect(await pending(l, "emma")).toEqual([]);
      expect(await pending(l, "emma", "cancelled")).toHaveLength(1);
    });

    it("leaves a processing handoff alone", async () => {
      const l = await layout();
      await writeJobs(l.coordinatorStateDir, [atJob()]);
      const c = await start(l);
      await c.tick();
      const [name] = await pending(l, "emma");
      const root = join(l.dir("emma"), "job-handoffs");
      await mkdir(join(root, "processing"), { mode: 0o700 });
      const { rename } = await import("node:fs/promises");
      await rename(join(root, "pending", name!), join(root, "processing", name!));
      await writeJobs(l.coordinatorStateDir, [atJob({ prompt: "Changed", at: "2999-01-01T00:00:00Z" })]);
      await c.reload();
      expect(await pending(l, "emma", "processing")).toEqual([name]);
      expect(await pending(l, "emma", "cancelled")).toEqual([]);
    });
  });
});
