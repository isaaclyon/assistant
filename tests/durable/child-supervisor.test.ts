import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ChildManifest, ChildOutcome } from '../../src/durable/child-contracts.js';
import { createChildSupervisor, type ChildArtifactsPort } from '../../src/durable/child-supervisor.js';

const WORKER = join(process.cwd(), 'tests/durable/child-supervisor-worker.mjs');
const B = 'batch', J = 'job';
let root: string;
let leases: Set<string>;
let cancels: Set<string>;
let spawns: number;
let busyAttempts: number;
let manifest: ChildManifest | undefined;
const sup: Array<ReturnType<typeof createChildSupervisor>> = [];

const dir = () => join(root, B, J);
const fake = (): ChildArtifactsPort => ({
  tryBatchLease: async id => { if (leases.has(id)) { busyAttempts++; return undefined; } leases.add(id); return () => { leases.delete(id); }; },
  readManifest: async () => manifest,
  readOutcome: async () => existsSync(join(dir(), 'outcome.json')) ? JSON.parse(await readFile(join(dir(), 'outcome.json'), 'utf8')) as ChildOutcome : undefined,
  writeOutcome: async o => { await writeFile(join(dir(), 'outcome.json'), JSON.stringify(o)); },
  requestCancel: async () => { cancels.add(J); await writeFile(join(dir(), 'cancel'), '1'); },
  isCancelRequested: async () => existsSync(join(dir(), 'cancel')),
  tryWriterLease: async () => existsSync(join(dir(), 'writer')) ? undefined : () => {},
  jobDir: () => dir(),
});
const make = (extra: Record<string, unknown> = {}) => {
  const s = createChildSupervisor({
    stateDir: root, workerPath: WORKER, artifacts: fake(),
    spawnWorker: a => { spawns++; return fork(WORKER, [a.stateDir, a.batchId, a.jobId], { execArgv: [], env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); },
    ...extra,
  });
  sup.push(s);
  return s;
};
const control = (o: { signal?: AbortSignal; canRun?: boolean; cancelled?: () => boolean } = {}) => ({
  signal: o.signal ?? new AbortController().signal,
  canRun: async () => o.canRun ?? true,
  isCancelled: async () => o.cancelled?.() ?? false,
});
const mode = (m: string) => writeFile(join(dir(), 'mode'), m);
// A killed worker leaves its flag file; an OS lock would be released, so emulate that once the pid is dead.
const releaseDeadWriter = () => {
  const t = setInterval(async () => {
    try { const pid = Number(await readFile(join(dir(), 'writer'), 'utf8')); if (!alive(pid)) await rm(join(dir(), 'writer'), { force: true }); } catch { /* not yet */ }
  }, 50);
  return () => clearInterval(t);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'child-supervisor-'));
  await mkdir(dir(), { recursive: true });
  leases = new Set(); cancels = new Set(); spawns = 0; busyAttempts = 0;
  manifest = {
    version: 1, batchId: B, jobId: J, launchId: 'launch-1', purpose: 'p', createdAt: 0, expiresAt: Date.now() + 1e9,
    deadlineAt: Date.now() + 60_000, endCondition: 'e', task: 't', context: '', model: { provider: 'x', modelId: 'y' },
    thinkingLevel: 'off', roots: [], workspaceCwd: root, provider: { credentialPath: '', settingsPath: '', account: '' },
  } as ChildManifest;
});
afterEach(async () => {
  await Promise.all(sup.splice(0).map(s => s.close()));
  await rm(root, { recursive: true, force: true });
});

test('runs a worker, returns its outcome, releases the lease and sanitizes the environment', async () => {
  await mode('ok');
  const s = make();
  const p = s.run(B, J, control());
  expect(s.active(B)).toBe(true);
  const out = await p;
  expect(out?.status).toBe('completed');
  expect(spawns).toBe(1);
  expect(leases.size).toBe(0);
  expect(s.active(B)).toBe(false);
  const env = JSON.parse(await readFile(join(dir(), 'env.json'), 'utf8')) as { env: string[] };
  expect(env.env).not.toContain('HOME');
});

test('holds the batch lease until ready and never spawns twice for concurrent runs', async () => {
  await mode('slowready');
  const s = make();
  const first = s.run(B, J, control());
  await new Promise(r => setTimeout(r, 300));
  expect(leases.has(B)).toBe(true);
  const second = s.run(B, J, control());
  const [a, b] = await Promise.all([first, second]);
  expect(a?.status).toBe('completed');
  expect(b?.status).toBe('completed');
  expect(spawns).toBe(1);
  expect(busyAttempts).toBeGreaterThan(0);
});

test('an unknown busy writer holds: no spawn, no outcome, no kill', async () => {
  await mode('ok');
  await writeFile(join(dir(), 'writer'), '1');
  const ac = new AbortController();
  const p = make().run(B, J, control({ signal: ac.signal }));
  await new Promise(r => setTimeout(r, 900));
  expect(spawns).toBe(0);
  expect(leases.size).toBe(0); // released while waiting
  ac.abort();
  expect(await p).toBeUndefined();
  expect(existsSync(join(dir(), 'outcome.json'))).toBe(false);
});

test('an existing outcome is returned only after the writer is closed', async () => {
  await mode('ok');
  await writeFile(join(dir(), 'outcome.json'), JSON.stringify({ batchId: B, jobId: J, launchId: 'launch-1', version: 1, status: 'completed', output: 'x', finishedAt: 1 }));
  await writeFile(join(dir(), 'writer'), '1');
  const p = make().run(B, J, control());
  let settled = false; void p.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 700));
  expect(settled).toBe(false);
  await rm(join(dir(), 'writer'));
  expect((await p)?.status).toBe('completed');
  expect(spawns).toBe(0);
});

test('an outcome with a different launch identity is not reported', async () => {
  await writeFile(join(dir(), 'outcome.json'), JSON.stringify({ batchId: B, jobId: J, launchId: 'zzz', version: 1, status: 'completed', output: 'x', finishedAt: 1 }));
  expect(await make().run(B, J, control())).toBeUndefined();
  expect(spawns).toBe(0);
});

test('canRun false returns without touching artifacts', async () => {
  expect(await make().run(B, J, control({ canRun: false }))).toBeUndefined();
  expect(spawns).toBe(0);
  expect(existsSync(join(dir(), 'outcome.json'))).toBe(false);
});

test('cancelled or expired before spawn writes a fixed outcome without spawning', async () => {
  const c = await make().run(B, J, control({ cancelled: () => true }));
  expect(c?.status).toBe('cancelled');
  expect(spawns).toBe(0);
  await rm(join(dir(), 'outcome.json')); await rm(join(dir(), 'cancel'));
  manifest!.deadlineAt = Date.now() - 1;
  const t = await make().run(B, J, control());
  expect(t?.status).toBe('timed_out');
  expect(spawns).toBe(0);
});

test('cancel during a run persists the marker and the worker reports cancelled', async () => {
  await mode('cancelaware');
  let cancelled = false;
  const p = make().run(B, J, control({ cancelled: () => cancelled }));
  await new Promise(r => setTimeout(r, 500));
  cancelled = true;
  expect((await p)?.status).toBe('cancelled');
  expect(cancels.has(J)).toBe(true);
});

test('abort shuts the worker down without marking anything terminal', async () => {
  await mode('hang');
  const ac = new AbortController();
  const p = make().run(B, J, control({ signal: ac.signal }));
  await new Promise(r => setTimeout(r, 600));
  const pid = Number(await readFile(join(dir(), 'writer'), 'utf8'));
  expect(alive(pid)).toBe(true);
  ac.abort();
  expect(await p).toBeUndefined();
  expect(alive(pid)).toBe(false);
  expect(cancels.size).toBe(0);
  expect(existsSync(join(dir(), 'outcome.json'))).toBe(false);
  expect(leases.size).toBe(0);
});

test('close() terminates owned children and leaves the job unfinished', async () => {
  await mode('hang');
  const s = make();
  const p = s.run(B, J, control());
  await new Promise(r => setTimeout(r, 600));
  const pid = Number(await readFile(join(dir(), 'writer'), 'utf8'));
  await s.close();
  expect(alive(pid)).toBe(false);
  expect(await p).toBeUndefined();
  expect(existsSync(join(dir(), 'outcome.json'))).toBe(false);
});

test('stdout beyond 256 KiB kills the worker and fails the job', async () => {
  await mode('flood');
  const out = await make().run(B, J, control());
  expect(out?.status).toBe('failed');
  expect(out?.output).not.toContain('xxx');
});

test('a ready message with the wrong identity fails the job', async () => {
  await mode('badid');
  expect((await make().run(B, J, control()))?.status).toBe('failed');
});

test('an unprompted exit without an outcome fails the job once', async () => {
  await mode('crash');
  expect((await make().run(B, J, control()))?.status).toBe('failed');
  expect(spawns).toBe(1);
});

test('a worker that never becomes ready is terminated, escalating to SIGKILL', async () => {
  await mode('stubborn-noready');
  const started = Date.now();
  const stop = releaseDeadWriter();
  const out = await make().run(B, J, control());
  stop();
  expect(out?.status).toBe('failed');
  expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
}, 60_000);

test('deadline during a run terminates the worker and reports timed_out', async () => {
  await mode('stubborn');
  manifest!.deadlineAt = Date.now() + 1000;
  const p = make().run(B, J, control());
  const stop = releaseDeadWriter();
  const out = await p;
  stop();
  expect(out?.status).toBe('timed_out');
}, 60_000);

test('unused spawn type import stays valid', () => { const f: ChildProcess | undefined = undefined; expect(f).toBeUndefined(); });
