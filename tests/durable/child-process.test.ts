import { execFile, fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { ChildArtifacts } from '../../src/durable/child-artifacts.js';
import type { ChildManifest } from '../../src/durable/child-contracts.js';
import type { createChildSupervisor, ChildControl } from '../../src/durable/child-supervisor.js';
import { createNativeChildren, NativeChildren } from '../../src/durable/children.js';
import { DurableHost } from '../../src/durable/host.js';
import { context } from '../../src/durable/ingress.js';
import type { NativeConfig } from '../../src/durable/config.js';
import { openHostStorage } from '../../src/durable/storage.js';

const WORKER = join(process.cwd(), 'tests/durable/child-process-worker.mjs');
const RETENTION_WORKER = join(process.cwd(), 'tests/durable/child-retention-crash-worker.mjs');
const B = 'a'.repeat(64), J = 'b'.repeat(64);
const MARKER = 'FIXTURE_FILE_PAYLOAD_7d1c';
const CHILD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
let compiled: string;
let createCompiledSupervisor: typeof createChildSupervisor;
const cleanup: Array<() => Promise<unknown> | unknown> = [];

beforeAll(async () => {
  const cache = join(process.cwd(), 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  compiled = await mkdtemp(join(cache, 'child-process-'));
  await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2024',
    '--rootDir', '.', '--outDir', compiled, 'src/durable/child-worker.ts', 'src/durable/child-supervisor.ts', 'src/durable/children.ts', 'src/durable/host.ts', 'src/durable/child-artifacts.ts', 'src/durable/ingress.ts'], { timeout: 90_000 });
  ({ createChildSupervisor: createCompiledSupervisor } = await import(pathToFileURL(join(compiled, 'src/durable/child-supervisor.js')).href));
}, 100_000);
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

type Scenario = 'report' | 'hang' | 'resume' | 'pre-disconnect';
async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'child-process-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'), workspace = join(root, 'workspace'), probe = join(root, 'probe');
  for (const dir of [stateDir, workspace, probe]) await mkdir(dir, { mode: 0o700 });
  const file = join(workspace, 'fixture.txt');
  await writeFile(file, MARKER);
  const scenario = (name: Scenario) => writeFile(join(probe, 'scenario.json'), JSON.stringify({ name, file, marker: MARKER }));
  const calls = async () => existsSync(join(probe, 'calls.jsonl')) ? (await readFile(join(probe, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { name: string; index: number; pid: number; cwd: string; tool: boolean; tasks: number; env: string[] }) : [];
  return { root, stateDir, workspace, probe, file, scenario, calls };
}
function fauxIdentity() {
  const faux = fauxProvider(); const m = faux.getModel();
  return { provider: m.provider, modelId: m.id };
}
function manifestFor(l: Awaited<ReturnType<typeof layout>>, over: Partial<ChildManifest> = {}): ChildManifest {
  const createdAt = Date.now();
  return { version: 1, batchId: B, jobId: J, launchId: 'launch-process', purpose: 'acceptance', createdAt, expiresAt: createdAt + 1e9, deadlineAt: createdAt + 120_000,
    endCondition: 'test', task: 'Read fixture.txt and report', context: 'CTX', model: fauxIdentity(), thinkingLevel: 'off', roots: [l.workspace], workspaceCwd: l.workspace,
    provider: { credentialPath: '/unused', settingsPath: '/unused', account: 'test' }, ...over };
}
function spawner(l: Awaited<ReturnType<typeof layout>>, counter: { spawns: number }) {
  return (a: { stateDir: string; batchId: string; jobId: string }): ChildProcess => {
    counter.spawns++;
    return fork(WORKER, [compiled, a.stateDir, a.batchId, a.jobId, l.probe], { cwd: l.workspace, execArgv: [], env: { PATH: CHILD_PATH }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  };
}
const control = (o: { signal?: AbortSignal; cancelled?: () => boolean } = {}): ChildControl => ({ signal: o.signal ?? new AbortController().signal, canRun: async () => true, isCancelled: async () => o.cancelled?.() ?? false });
async function prepared(over: Partial<ChildManifest> = {}) {
  const l = await layout();
  const artifacts = new ChildArtifacts(l.stateDir);
  const manifest = manifestFor(l, over);
  await artifacts.prepare(manifest);
  const counter = { spawns: 0 };
  const supervisor = createCompiledSupervisor({ stateDir: l.stateDir, spawnWorker: spawner(l, counter) });
  cleanup.push(() => supervisor.close());
  return { l, artifacts, manifest, counter, supervisor };
}
const storeBytes = async (dir: string) => Buffer.concat(await Promise.all((await readdir(dir)).filter(n => n.startsWith('harness.db')).map(n => readFile(join(dir, n)))));
const writerFree = async (a: ChildArtifacts) => { const release = await a.tryWriterLease(B, J); expect(release).toBeTypeOf('function'); release!(); };
const until = (check: () => Promise<boolean>, ms = 20_000) => vi.waitFor(async () => expect(await check()).toBe(true), { timeout: ms, interval: 50 });

test('supervisor and compiled worker complete a repo_read report, keeping the transcript in the private child store', async () => {
  const { l, artifacts, manifest, counter, supervisor } = await prepared();
  await l.scenario('report');
  const outcome = await supervisor.run(B, J, control());
  expect(outcome).toMatchObject({ status: 'completed', output: 'REPORT_OK tool=true', launchId: manifest.launchId });
  expect(counter.spawns).toBe(1);
  expect(await artifacts.readOutcome(B, J)).toEqual(outcome);
  const calls = await l.calls();
  expect(calls).toHaveLength(2);
  for (const c of calls) { expect(c.env).toContain('PATH'); expect(c.env.filter(k => /KEY|TOKEN|SECRET|AUTH|PROXY|HOME|TELEGRAM/i.test(k))).toEqual([]); }
  const store = join(artifacts.jobDir(B, J), 'store');
  const db = new DatabaseSync(join(store, 'harness.db'), { readOnly: true });
  try { expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal'); } finally { db.close(); }
  expect((await storeBytes(store)).includes(MARKER)).toBe(true);
  await writerFree(artifacts);
  // A second run returns the persisted outcome without another process or model call.
  expect(await supervisor.run(B, J, control())).toEqual(outcome);
  expect(counter.spawns).toBe(1);
  expect(await l.calls()).toHaveLength(2);
}, 60_000);

test('compiled supervisor default fork uses the manifest workspace and fixed environment', async () => {
  const l = await layout();
  await l.scenario('report');
  await writeFile(join(l.workspace, '.child-fixture.json'), JSON.stringify({ compiled, probe: l.probe }));
  const artifacts = new ChildArtifacts(l.stateDir);
  await artifacts.prepare(manifestFor(l));
  const supervisor = createCompiledSupervisor({ stateDir: l.stateDir, workerPath: WORKER });
  cleanup.push(() => supervisor.close());
  expect(await supervisor.run(B, J, control())).toMatchObject({ status: 'completed', output: 'REPORT_OK tool=true' });
  const calls = await l.calls();
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.cwd).toBe(l.workspace);
    expect(call.env).toContain('PATH');
    expect(call.env.filter(key => /KEY|TOKEN|SECRET|AUTH|PROXY|HOME|TELEGRAM/i.test(key))).toEqual([]);
  }
  await writerFree(artifacts);
}, 30_000);

test('parent interruption leaves no outcome; the same store resumes the original request and deadline', async () => {
  const { l, artifacts, manifest, counter, supervisor } = await prepared();
  await l.scenario('hang');
  const abort = new AbortController();
  const first = supervisor.run(B, J, control({ signal: abort.signal }));
  await until(async () => (await l.calls()).length === 2);
  abort.abort('parent interrupted');
  expect(await first).toBeUndefined();
  expect(await artifacts.readOutcome(B, J)).toBeUndefined();
  await writerFree(artifacts);

  await l.scenario('resume');
  const outcome = await supervisor.run(B, J, control());
  expect(outcome).toMatchObject({ status: 'completed', output: 'RESUMED tool=true', launchId: manifest.launchId });
  expect(counter.spawns).toBe(2);
  const calls = await l.calls();
  expect(new Set(calls.map(c => c.pid)).size).toBe(2);
  expect(calls.at(-1)).toMatchObject({ name: 'resume', tasks: 1, tool: true });
  expect(await artifacts.readManifest(B, J)).toEqual(manifest);
}, 60_000);

test('a vanished parent IPC channel interrupts the worker without an outcome', async () => {
  const { l, artifacts } = await prepared();
  await l.scenario('hang');
  const child = fork(WORKER, [compiled, l.stateDir, B, J, l.probe], { cwd: l.workspace, execArgv: [], env: { PATH: CHILD_PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  cleanup.push(() => { child.kill('SIGKILL'); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const ready = new Promise<unknown>(resolve => child.once('message', resolve));
  expect(await ready).toMatchObject({ event: 'ready', batchId: B, jobId: J });
  await until(async () => (await l.calls()).length === 2);
  child.disconnect();
  expect(await Promise.race([exited, new Promise<string>(r => setTimeout(() => r('timeout'), 20_000))])).toBe(0);
  expect(await artifacts.readOutcome(B, J)).toBeUndefined();
  await writerFree(artifacts);
}, 60_000);

test('IPC disconnected before worker startup leaves the prepared store empty', async () => {
  const { l, artifacts } = await prepared();
  await l.scenario('pre-disconnect');
  const child = fork(WORKER, [compiled, l.stateDir, B, J, l.probe], { cwd: l.workspace, execArgv: [], env: { PATH: CHILD_PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  cleanup.push(() => { child.kill('SIGKILL'); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const messages: unknown[] = [];
  child.on('message', message => messages.push(message));
  await vi.waitFor(() => expect(messages).toContainEqual({ fixture: 'before-child-main' }), { timeout: 10_000, interval: 20 });
  child.disconnect();
  expect(await Promise.race([exited, new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 20_000))])).toBe(0);
  expect(JSON.parse(await readFile(join(l.probe, 'entry.json'), 'utf8'))).toEqual({ connected: false });
  expect(await l.calls()).toEqual([]);
  expect(await artifacts.readOutcome(B, J)).toBeUndefined();
  // prepare() creates this private directory; the interrupted worker must not open
  // a Harness or leave a writer lock, database, WAL or SHM file in it.
  expect(await readdir(join(artifacts.jobDir(B, J), 'store'))).toEqual([]);
  await writerFree(artifacts);
}, 30_000);

test('cancellation and deadline produce terminal outcomes only after the writer closes', async () => {
  const cancelled = await prepared();
  await cancelled.l.scenario('hang');
  let cancel = false;
  const run = cancelled.supervisor.run(B, J, control({ cancelled: () => cancel }));
  await until(async () => (await cancelled.l.calls()).length === 2);
  cancel = true;
  const outcome = await run;
  expect(outcome).toMatchObject({ status: 'cancelled' });
  expect(await cancelled.artifacts.isCancelRequested({ batchId: B, jobId: J, launchId: cancelled.manifest.launchId })).toBe(true);
  await writerFree(cancelled.artifacts);

  const deadline = await prepared({ deadlineAt: Date.now() + 6_000 });
  await deadline.l.scenario('hang');
  const timing = deadline.supervisor.run(B, J, control());
  await until(async () => (await deadline.l.calls()).length === 2, 5_000);
  const timed = await timing;
  expect(timed).toMatchObject({ status: 'timed_out' });
  expect(timed?.status).not.toBe('completed');
  expect(deadline.counter.spawns).toBe(1);
  await writerFree(deadline.artifacts);
}, 90_000);

test('an unknown writer holding the store blocks spawning and any false completion', async () => {
  const { l, artifacts, counter, supervisor, manifest } = await prepared();
  await l.scenario('report');
  const held = await openHostStorage(join(artifacts.jobDir(B, J), 'store'));
  const abort = new AbortController();
  const run = supervisor.run(B, J, control({ signal: abort.signal }));
  await new Promise(r => setTimeout(r, 1_000));
  abort.abort('stop waiting');
  expect(await run).toBeUndefined();
  expect(counter.spawns).toBe(0);
  expect(await artifacts.readOutcome(B, J)).toBeUndefined();
  // A worker started anyway exits without readiness or an outcome (lease busy).
  const rogue = fork(WORKER, [compiled, l.stateDir, B, J, l.probe], { cwd: l.workspace, execArgv: [], env: { PATH: CHILD_PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  cleanup.push(() => { rogue.kill('SIGKILL'); });
  const messages: unknown[] = [];
  rogue.on('message', m => messages.push(m));
  const code = await Promise.race([new Promise<number | null>(r => rogue.once('exit', c => r(c))), new Promise<string>(r => setTimeout(() => r('timeout'), 20_000))]);
  expect(code).toBe(3);
  expect(messages).toEqual([]);
  expect(await artifacts.readOutcome(B, J)).toBeUndefined();
  await held.storage.close(context); held.release();
  const recovered = createCompiledSupervisor({ stateDir: l.stateDir, spawnWorker: spawner(l, counter) });
  cleanup.push(() => recovered.close());
  expect(await recovered.run(B, J, control())).toMatchObject({ status: 'completed', launchId: manifest.launchId });
}, 60_000);

function mainConfig(root: string, stateDir: string, workspace: string): NativeConfig {
  return { stateDir, workspaceCwd: workspace, resourceRoot: workspace, principal: 'isaac', instanceId: 'test', credentialPath: join(root, 'unused'), settingsPath: join(root, 'unused'), account: 'test', transport: { botId: 123, allowedUserId: 42 } } as unknown as NativeConfig;
}
function mainProvider() {
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
  const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel();
  return { faux, models, model: { provider: m.provider, modelId: m.id }, provider: { models, provider: faux.provider, model: { provider: m.provider, modelId: m.id }, thinkingLevel: 'off' as const, close() {} } };
}

test('real supervisor and worker run from a main launch; the child transcript never enters the main store', async () => {
  const l = await layout();
  await l.scenario('report');
  const p = mainProvider();
  const counter = { spawns: 0 };
  const config = mainConfig(l.root, l.stateDir, l.workspace);
  let host!: DurableHost;
  const supervisor = createCompiledSupervisor({ stateDir: l.stateDir, spawnWorker: spawner(l, counter) });
  const service = createNativeChildren({ config, host: () => host, provider: p.provider, supervisor });
  const finals: string[] = [];
  const registry = createRegistry(); const bundle = service.bundle();
  registry.install(defineExtension({ name: bundle.name, ...bundle.contributions, tools: bundle.tools.map(x => x.tool) }));
  const mainDir = join(l.root, 'main');
  host = await DurableHost.create({ stateDir: mainDir, models: p.models, registry, agent: { model: p.model, instructions: 'Synthetic', cwd: l.workspace },
    compatibility: { runtimeGeneration: 't', releaseSchema: 1, profile: 't', registrySignature: 't' }, policy() {}, controlPolicy() {}, settings: { retry: { enabled: false }, compaction: { enabled: false } },
    transport: { async start() {}, async stop() {}, async sendFinal(r) { finals.push(r.text); return { messageId: finals.length }; } } });
  cleanup.push(async () => { await host.close(); await service.close(); });
  const launch = answer(fauxToolCall('background_subagents', { operation: 'launch', tasks: [{ task: 'Read fixture.txt', model: `${p.model.provider}/${p.model.modelId}`, thinking: 'off' }] } as never), { stopReason: 'toolUse' });
  p.faux.setResponses([launch, answer('LAUNCHED'), answer('SYNTHESIZED')]);
  await host.start();
  await host.receive({ instance: 'test', principal: 'isaac', bot: '123', chatId: 42, messageIds: [1], originalAt: 1_700_000_000_001, content: 'Delegate' });
  const state = async () => Object.values((await host.runtime.harness.snapshot(NativeChildren, host.runtime.root.id, context))?.batches ?? {});
  await vi.waitFor(async () => expect((await state())[0]?.report.status).toBe('done'), { timeout: 45_000, interval: 100 });
  const [batch] = await state();
  expect(batch!.jobs[0]!.status).toBe('completed');
  expect(finals).toEqual(['LAUNCHED', 'SYNTHESIZED']);
  const childStore = join(service.artifacts.jobDir(batch!.id, batch!.jobs[0]!.id), 'store');
  expect((await storeBytes(childStore)).includes(MARKER)).toBe(true);
  await host.close();
  expect((await storeBytes(mainDir)).includes(MARKER)).toBe(false);
  expect((await storeBytes(mainDir)).includes('REPORT_OK')).toBe(true); // only the bounded report crosses over
  expect(counter.spawns).toBe(1);
}, 90_000);

test('SIGKILL after the tombstone commit retains the tombstone, then cleanup removes private files without a relaunch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'child-retention-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'), workspace = join(root, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  const worker = fork(RETENTION_WORKER, [compiled, root, B, J], { execArgv: [], env: { PATH: CHILD_PATH }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  cleanup.push(() => { worker.kill('SIGKILL'); });
  let stderr = '';
  worker.stderr!.on('data', c => stderr += String(c));
  const paused = new Promise<void>((resolve, reject) => {
    worker.on('message', (m: { type?: string }) => { if (m.type === 'paused') resolve(); });
    worker.once('exit', (code, signal) => reject(new Error(`Early worker exit ${code} ${signal}: ${stderr}`)));
    setTimeout(() => reject(new Error(`Worker IPC timeout: ${stderr}`)), 30_000);
  });
  const exited = new Promise<string | null>(resolve => worker.once('exit', (_c, signal) => resolve(signal)));
  await paused;
  worker.kill('SIGKILL');
  expect(await exited).toBe('SIGKILL');

  const artifacts = new ChildArtifacts(stateDir);
  const jobStore = join(artifacts.jobDir(B, J), 'store');
  expect(existsSync(join(jobStore, 'harness.db'))).toBe(true);
  const p = mainProvider();
  const config = mainConfig(root, stateDir, workspace);
  let host!: DurableHost;
  let clock = Date.now();
  const counter = { spawns: 0 };
  const supervisor = createCompiledSupervisor({ stateDir, spawnWorker: spawner({ probe: root, workspace } as never, counter) });
  const service = createNativeChildren({ config, host: () => host, provider: p.provider, supervisor, now: () => clock });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'retention-recovery', tasks: [service.jobTask, service.reportTask] }));
  host = await DurableHost.create({ stateDir: join(root, 'main'), models: p.models, registry, agent: { model: p.model, instructions: 'Synthetic', cwd: workspace },
    compatibility: { runtimeGeneration: 't', releaseSchema: 1, profile: 't', registrySignature: 't' }, policy() {}, controlPolicy() {},
    transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } } });
  cleanup.push(async () => { await host.close(); await service.close(); });
  const batch = async () => (await host.runtime.harness.snapshot(NativeChildren, host.runtime.root.id, context))!.batches[B]!;
  expect(await batch()).toMatchObject({ tombstone: true, removed: false });
  clock = Number((await batch()).expiresAt) + 1;
  const taskId = (await batch()).jobs[0]!.taskId!;
  expect((await host.runtime.harness.getTask(taskId, context))?.state.status).not.toBe('terminal');
  // Resume the persisted production jobTask through the host, using its real
  // tombstone policy rather than a test-authored canRun callback.
  await host.start();
  await vi.waitFor(async () => expect((await host.runtime.harness.getTask(taskId, context))?.state.status).toBe('terminal'), { timeout: 5_000 });
  expect(counter.spawns).toBe(0);
  // The killed process released its OS lease; a held lease makes cleanup skip.
  const lease = await artifacts.tryBatchLease(B);
  expect(lease).toBeTypeOf('function');
  await service.cleanup(true);
  expect(await batch()).toMatchObject({ tombstone: true, removed: false });
  expect(existsSync(jobStore)).toBe(true);
  lease!();

  await service.cleanup(true);
  expect(await batch()).toMatchObject({ tombstone: true, removed: true });
  expect(existsSync(artifacts.batchDir(B))).toBe(false);
  for (const name of ['harness.db', 'harness.db-wal', 'harness.db-shm']) expect(existsSync(join(jobStore, name))).toBe(false);
  expect(existsSync(join(stateDir, 'temporary', 'background-children-control', `${B}.db`))).toBe(true);
  await service.cleanup(true);
  expect(existsSync(artifacts.batchDir(B))).toBe(false);
  await host.reconcile();
  expect((await host.runtime.harness.getTask(taskId, context))?.state.status).toBe('terminal');
  expect(counter.spawns).toBe(0);
}, 90_000);
