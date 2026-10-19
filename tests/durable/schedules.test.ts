import { createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type NativeJobsCoordinator, startNativeJobsCoordinator } from "../../src/durable/coordinator.js";
import {
  type NativeScheduleConfig,
  sanitizedCheckerEnvironment,
  SUPPORTED_NATIVE_CHECKER_IDS,
} from "../../src/durable/schedules.js";
import type { NativeGoogleConfig } from "../../src/durable/config.js";
import { cancelJobHandoff, enqueueJobHandoff } from "../../src/job-handoff.js";

const START = Date.parse("2026-07-18T10:00:00.000Z");
const HOUR = 3_600_000;
const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-schedules-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const coordinatorStateDir = join(root, "coordinator");
  const dirs = [stateRoot, join(stateRoot, "instances"), coordinatorStateDir,
    ...["isaac", "emma"].map((id) => join(stateRoot, "instances", id))];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
  }
  return { stateRoot, coordinatorStateDir, dir: (id: string) => join(stateRoot, "instances", id) };
}
type Layout = Awaited<ReturnType<typeof layout>>;

const google = { account: "synthetic@example.test", gog: { binary: "/opt/gog", passwordFile: "/secrets/gog", home: "/gog-home" } };
const configFor = (schedules: NativeScheduleConfig | undefined) => schedules;

async function start(
  l: Layout,
  schedules: NativeScheduleConfig | undefined,
  seams: Parameters<typeof startNativeJobsCoordinator>[1]["schedules"] = {},
  extra: Partial<Parameters<typeof startNativeJobsCoordinator>[1]> & { google?: NativeGoogleConfig | undefined } = {},
  clock: { ms: number } = { ms: START },
): Promise<NativeJobsCoordinator> {
  const { google: g, ...options } = extra;
  const c = await startNativeJobsCoordinator(
    {
      instanceId: "isaac",
      stateDir: l.dir("isaac"),
      coordinator: {
        stateRoot: l.stateRoot, coordinatorStateDir: l.coordinatorStateDir,
        targets: ["isaac", "emma"], scope: "shared-owner",
        ...(configFor(schedules) === undefined ? {} : { schedules }),
      },
      ...(g === undefined ? {} : { google: g }),
    },
    { logger: logs, nowMs: () => clock.ms, ...(schedules === undefined ? {} : { schedules: seams }), ...options },
  );
  cleanups.push(() => c.stop());
  return c;
}

const writeJobs = (l: Layout, jobs: unknown[]) =>
  writeFile(join(l.coordinatorStateDir, "jobs.json"), `${JSON.stringify({ version: 3, jobs })}\n`, { mode: 0o600 });
const handoffs = (l: Layout, state = "pending") =>
  readdir(join(l.dir("emma"), "job-handoffs", state)).catch(() => [] as string[]);
const checkerState = async (l: Layout, id: string) =>
  JSON.parse(await readFile(join(l.coordinatorStateDir, "checkers", `${id}.json`), "utf8"));

const heartbeat = (over: Record<string, unknown> = {}) => ({
  id: "watch", type: "heartbeat", schedule: "0 * * * *", tz: "UTC", target: "emma",
  checker: { id: "web-page-items", args: { url: "https://example.test/a" } },
  rule: { type: "changed" },
  onTrigger: { type: "prompt", prompt: "Review the change" },
  ...over,
});
const inboxJob = () => heartbeat({
  id: "inbox",
  checker: { id: "gmail-inbox", mode: "incremental", args: { account: "synthetic@example.test", timeZone: "UTC" } },
  rule: {
    type: "semantic-match", question: "Does {item} need action?",
    criteria: { true: "Action needed", false: "No action" }, notifyAt: 0.5,
  },
});
const snapshot = (value: unknown) => ({ ok: true, stdout: JSON.stringify({ version: 1, value }) });
const incremental = (since: number, ...ids: string[]) => ({
  ok: true,
  stdout: JSON.stringify({ version: 2, value: { items: ids.map((id) => ({ id, subject: `Subject ${id}` })) }, cursor: { since } }),
});

describe("native schedule execution", () => {
  it("runs snapshot heartbeats: silent baseline, one change, and retried publication before the next read", async () => {
    vi.stubEnv("PI_TELEGRAM_OPENAI_API_KEY_FILE", "/ambient/secret");
    const l = await layout();
    const clock = { ms: START };
    const runCheck = vi.fn().mockResolvedValue(snapshot({ price: 10 }));
    let failPublication = false;
    const enqueue = vi.fn(async (o: Parameters<typeof enqueueJobHandoff>[0]) => {
      if (failPublication) throw new Error("injected");
      return enqueueJobHandoff(o);
    });
    await writeJobs(l, [heartbeat()]);
    const c = await start(l, { checkerIds: ["web-page-items"] }, { runCheck },
      { publication: { enqueue, cancel: cancelJobHandoff } }, clock);

    clock.ms += HOUR;
    await c.tick();
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0]![4].env).not.toHaveProperty("PI_TELEGRAM_OPENAI_API_KEY_FILE");
    expect(await handoffs(l)).toEqual([]);

    runCheck.mockResolvedValue(snapshot({ price: 8 }));
    failPublication = true;
    clock.ms += HOUR;
    await c.tick();
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(await handoffs(l)).toEqual([]);

    failPublication = false;
    clock.ms += HOUR;
    await c.tick();
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(await handoffs(l)).toHaveLength(1);
    expect((await checkerState(l, "watch")).pendingEvent ?? null).toBeNull();
  });

  it("commits incremental cursors only after judging, and survives publication failure and restart", async () => {
    const l = await layout();
    const clock = { ms: START };
    const runCheck = vi.fn().mockResolvedValue(incremental(1));
    const judge = vi.fn().mockResolvedValue({ model: "synthetic", probabilities: { item_0: 0.9 } });
    let failPublication = true;
    const enqueue = vi.fn(async (o: Parameters<typeof enqueueJobHandoff>[0]) => {
      if (failPublication) throw new Error("injected");
      return enqueueJobHandoff(o);
    });
    const options = { publication: { enqueue, cancel: cancelJobHandoff }, google };
    await writeJobs(l, [inboxJob()]);
    let c = await start(l, { checkerIds: ["gmail-inbox"] }, { runCheck, judge }, options, clock);

    clock.ms += HOUR;
    await c.tick();
    expect(runCheck).toHaveBeenLastCalledWith("gmail-inbox", 60_000, expect.anything(), null, expect.anything());
    expect(judge).not.toHaveBeenCalled();

    runCheck.mockResolvedValue(incremental(2, "a"));
    judge.mockRejectedValueOnce(new Error("offline"));
    clock.ms += HOUR;
    await c.tick();
    expect((await checkerState(l, "inbox")).lastObservation.cursor).toEqual({ since: 1 });

    clock.ms += HOUR;
    await c.tick();
    expect(runCheck.mock.calls.at(-1)![3]).toEqual({ since: 1 });
    const saved = await checkerState(l, "inbox");
    expect(saved.lastObservation.cursor).toEqual({ since: 2 });
    expect(saved.pendingEvent.matches[0].item.id).toBe("a");
    expect(await handoffs(l)).toEqual([]);

    await c.stop();
    failPublication = false;
    c = await start(l, { checkerIds: ["gmail-inbox"] }, { runCheck, judge }, options, clock);
    clock.ms += HOUR;
    const reads = runCheck.mock.calls.length;
    await c.tick();
    expect(runCheck).toHaveBeenCalledTimes(reads);
    expect(await handoffs(l)).toHaveLength(1);
    expect((await checkerState(l, "inbox")).pendingEvent ?? null).toBeNull();
  });

  it("keeps the cursor when the configured judge key is absent", async () => {
    const l = await layout();
    const clock = { ms: START };
    const runCheck = vi.fn().mockResolvedValue(incremental(1));
    await writeJobs(l, [inboxJob()]);
    const c = await start(l, { checkerIds: ["gmail-inbox"] }, { runCheck }, { google }, clock);
    clock.ms += HOUR;
    await c.tick();
    runCheck.mockResolvedValue(incremental(2, "a"));
    clock.ms += HOUR;
    await c.tick();
    expect((await checkerState(l, "inbox")).lastObservation.cursor).toEqual({ since: 1 });
    expect(await handoffs(l)).toEqual([]);
  });

  it("rejects unselected checkers and job types before reconciling last-good jobs", async () => {
    const l = await layout();
    const future = { id: "later", type: "at", at: "2030-01-01T00:00:00Z", prompt: "Later", target: "emma" };
    await writeJobs(l, [future, heartbeat()]);
    const c = await start(l, { checkerIds: ["web-page-items"] }, { runCheck: vi.fn() });
    const before = c.getJobs().map((job) => job.id);
    expect(before).toEqual(["later", "watch"]);

    for (const bad of [
      heartbeat({ checker: { id: "retail-product-price" } }),
      { id: "hook", type: "webhook", prompt: "p", target: "emma" },
    ]) {
      await writeJobs(l, [bad]);
      await c.reload();
      expect(c.getJobs().map((job) => job.id)).toEqual(before);
      expect(logs.error).toHaveBeenLastCalledWith(expect.stringContaining("not supported by this scheduler"));
    }
    expect(c.webhookPort()).toBeUndefined();

    const noCheckers = await layout();
    await writeJobs(noCheckers, [heartbeat()]);
    const idle = await start(noCheckers, { checkerIds: [] }, {});
    expect(idle.getJobs()).toEqual([]);
  });

  it("validates schedule configuration before taking the lease", async () => {
    const l = await layout();
    const gmail = { checkerIds: ["gmail-inbox"] };
    const cases: Array<[NativeScheduleConfig, NativeGoogleConfig?]> = [
      [{ checkerIds: ["web-page-items", "web-page-items"] }],
      [{ checkerIds: ["unknown"] }],
      [{ checkerIds: [...SUPPORTED_NATIVE_CHECKER_IDS, "web-page-items"] }],
      [{ checkerIds: [], webhook: { port: 0 } }],
      [{ checkerIds: [], webhook: { port: 70000 } }],
      [{ checkerIds: [], judgeKeyFile: "relative/key" }],
      [gmail],
    ];
    for (const [schedules, g] of cases) await expect(start(l, schedules, {}, g === undefined ? {} : { google: g })).rejects.toThrow();
    const ok = await start(l, { checkerIds: ["web-page-items"] }, {});
    expect(ok.getJobs()).toEqual([]);
  });

  it("gives checkers only ordinary variables, and gmail alone the selected Google runtime", () => {
    const source = {
      PATH: "/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", LANG: "C", LC_ALL: "C", TZ: "UTC", TMPDIR: "/tmp",
      PI_TELEGRAM_TYPESAFE_API_KEY_FILE: "/k", PI_TELEGRAM_GOG_BINARY: "/ambient", GOG_KEYRING_PASSWORD: "x",
      PI_CREDENTIAL_ISAAC_TOKEN: "t", YNAB_API_KEY: "y",
    };
    const input = { source, google, coordinatorStateDir: "/coord" };
    const pub = sanitizedCheckerEnvironment({ ...input, checkerId: "web-page-items" });
    expect(Object.keys(pub).sort()).toEqual(["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "TMPDIR", "TZ", "USER"]);
    const mail = sanitizedCheckerEnvironment({ ...input, checkerId: "gmail-inbox" });
    expect(mail).toMatchObject({
      PI_TELEGRAM_GOG_BINARY: "/opt/gog", PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE: "/secrets/gog",
      PI_TELEGRAM_GOG_HOME: "/gog-home", PI_TELEGRAM_GOOGLE_ACCOUNT: "synthetic@example.test",
      PI_TELEGRAM_BRIDGE_STATE_DIR: "/coord",
    });
    expect(mail).not.toHaveProperty("PI_TELEGRAM_TYPESAFE_API_KEY_FILE");
    expect(() => sanitizedCheckerEnvironment({ ...input, google: undefined, checkerId: "gmail-inbox" })).toThrow();
  });

  describe("webhook", () => {
    const url = (c: NativeJobsCoordinator, path = "/hook/hook") => `http://127.0.0.1:${c.webhookPort()}${path}`;

    it("authenticates, bounds, materializes with 202, and retries publication", async () => {
      const l = await layout();
      let failPublication = true;
      const enqueue = vi.fn(async (o: Parameters<typeof enqueueJobHandoff>[0]) => {
        if (failPublication) throw new Error("injected");
        return enqueueJobHandoff(o);
      });
      await writeJobs(l, [{ id: "hook", type: "webhook", prompt: "Handle it", target: "emma", hmacSecret: "shared-synthetic" }]);
      const c = await start(l, { checkerIds: [], webhook: { port: 8123 } }, { webhookPort: 0 },
        { publication: { enqueue, cancel: cancelJobHandoff } });
      expect(c.webhookPort()).toBeGreaterThan(0);
      const secret = (await readFile(join(l.coordinatorStateDir, "webhook-secret"), "utf8")).trim();
      const body = JSON.stringify({ synthetic: true });

      expect((await fetch(url(c), { method: "POST", body })).status).toBe(401);
      expect((await fetch(url(c), { method: "POST", body, headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(url(c), { method: "POST", body, headers: { "x-hub-signature-256": "sha256=00" } })).status).toBe(401);
      expect((await fetch(url(c, "/hook/Bad_ID"), { method: "POST", body })).status).toBe(404);
      expect((await fetch(url(c), { method: "GET" })).status).toBe(404);
      expect((await fetch(url(c, "/hook/missing"), { method: "POST", body, headers: { authorization: `Bearer ${secret}` } })).status).toBe(404);
      const oversize = await fetch(url(c), {
        method: "POST", body: "x".repeat(300 * 1024), headers: { authorization: `Bearer ${secret}` },
      }).then((r) => r.status, () => 413);
      expect(oversize).toBe(413);
      expect(await handoffs(l)).toEqual([]);

      const signature = `sha256=${createHmac("sha256", "shared-synthetic").update(body).digest("hex")}`;
      expect((await fetch(url(c), { method: "POST", body, headers: { "x-hub-signature-256": signature } })).status).toBe(202);
      expect(await handoffs(l)).toEqual([]);

      failPublication = false;
      const bearer = await fetch(url(c), { method: "POST", body, headers: { authorization: `Bearer ${secret}` } });
      expect(bearer.status).toBe(202);
      await vi.waitFor(async () => expect(await handoffs(l)).toHaveLength(1));
      await c.tick();
      expect(await handoffs(l)).toHaveLength(2);
      expect(JSON.stringify(logs.info.mock.calls) + JSON.stringify(logs.error.mock.calls)).not.toContain(secret);
    });
  });
});
