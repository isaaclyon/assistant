import { fork, execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PlacesApplication } from '../../src/places-application.js';
import { openPlacesStore } from '../../src/places-store.js';
import { PlacesService } from '../../src/places-service.js';
import { Bindings, context } from '../../src/durable/ingress.js';
import { origin, ownerKey, placesCrashFixture } from './places-crash-fixture.js';

let compiled: string;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
beforeAll(async () => {
  const cache = join(process.cwd(), 'node_modules/.cache'); await mkdir(cache, { recursive: true }); compiled = await mkdtemp(join(cache, 'places-crash-'));
  await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2023', '--rootDir', '.', '--outDir', compiled, 'src/places-application.ts', 'tests/durable/places-crash-fixture.ts'], { timeout: 60_000 });
}, 70_000);
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'places-crash-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; }
type CrashMode = 'before' | 'after' | 'before-input' | 'after-input';
function worker(path: string, mode: CrashMode) {
  const child = fork(join(process.cwd(), 'tests/durable/places-crash-worker.mjs'), [compiled, path, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => stderr += String(chunk));
  const messages: Record<string, unknown>[] = []; const listeners = new Set<() => void>(); child.on('message', m => { messages.push(m as Record<string, unknown>); for (const fn of listeners) fn(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const wait = (event: string) => new Promise<Record<string, unknown>>((resolve, reject) => { const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${event}: ${stderr}`)); }, 30_000); const check = () => { const m = messages.find(x => x.event === event); if (m) { clearTimeout(timeout); listeners.delete(check); resolve(m); } }; listeners.add(check); check(); });
  return { child, wait, exited };
}
function ranking(path: string) {
  const store = openPlacesStore(join(path, 'places.db'));
  try { const service = new PlacesService(store, { ownerKey }); return service.listCategories().flatMap(c => service.listRanking(c.id)).map((p: { name: string }) => p.name); } finally { store.close(); }
}
async function crash(mode: CrashMode) {
  const path = await directory(), child = worker(path, mode);
  const paused = await child.wait('paused') as { key: string; messageId: number; commandId: string; replyToMessageId: number; text: string };
  child.child.kill('SIGKILL'); expect(await child.exited).toMatchObject({ signal: 'SIGKILL' });
  return { path, paused };
}
async function reopen(path: string) {
  const executes: string[] = []; const original = PlacesApplication.prototype.execute;
  (PlacesApplication.prototype as any).execute = function (params: { action: string }) { executes.push(params.action); return (original as any).call(this, params); };
  const fixture = await placesCrashFixture(path);
  cleanup.push(async () => { (PlacesApplication.prototype as any).execute = original; await fixture.close(); });
  return { fixture, executes };
}
const settle = <T>(p: Promise<T>) => p.then(value => ({ value }), error => ({ error: String(error?.message ?? error) }));
const effects = (executes: string[]) => executes.filter(a => a === 'start');

it.each([['before', []], ['after', ['Crash Cafe']]] as const)('SIGKILL %s the domain effect never re-executes it when the exact callback is resent', async (mode, expected) => {
  const { path, paused } = await crash(mode);
  expect(ranking(path)).toEqual(expected);
  const { fixture, executes } = await reopen(path);
  const before = fixture.presented.length;
  const toast = await settle(fixture.places.callback({ ...origin(paused.commandId, paused.messageId), key: paused.key, messageId: paused.messageId }));
  expect(effects(executes)).toHaveLength(0);
  expect(ranking(path)).toEqual(expected);
  expect(toast).toMatchObject({ value: {} });
  expect(fixture.latest().presentation.text).toMatch(/interrupted.*may or may not have been applied/s);
  // A second resend with another update ID stays inert.
  await settle(fixture.places.callback({ ...origin('resend-2', paused.messageId), key: paused.key, messageId: paused.messageId }));
  expect(effects(executes)).toHaveLength(0);
  expect(ranking(path)).toEqual(expected);
  // /place_rankings opens a fresh menu after the crash and still does not run the effect.
  await fixture.places.command(origin('menu-after'));
  expect(fixture.presented.length).toBeGreaterThan(before);expect(fixture.latest().presentation.text).toContain('Crash Cafe');
  expect(effects(executes)).toHaveLength(0);
  expect(ranking(path)).toEqual(expected);
}, 120_000);

it.each(['before', 'after'] as const)('/new epoch change after a %s-effect crash rejects the stale callback without effects', async mode => {
  const { path, paused } = await crash(mode);
  const expected = mode === 'after' ? ['Crash Cafe'] : [];
  const { fixture, executes } = await reopen(path);
  const epoch = async () => (await fixture.host.runtime.harness.snapshot(Bindings, fixture.host.runtime.root.id, context))?.epoch ?? 0;
  const first = await epoch();
  await fixture.host.runtime.root.commit(async tx => { (await tx.doc(Bindings, fixture.host.runtime.root.id)).epoch++; }, context);
  expect(await epoch()).toBe(first + 1);
  const count = fixture.presented.length;
  await settle(fixture.places.callback({ ...origin(paused.commandId, paused.messageId), key: paused.key, messageId: paused.messageId }));
  expect(fixture.presented.length).toBe(count);
  expect(effects(executes)).toHaveLength(0);
  expect(ranking(path)).toEqual(expected);
  await fixture.places.command(origin('menu-new-epoch'));
  expect(fixture.presented.length).toBeGreaterThan(count);
  expect(ranking(path)).toEqual(expected);
}, 120_000);


it.each(['before-input', 'after-input'] as const)('SIGKILL %s never repeats a captured category write on exact reply redelivery', async mode => {
  const { path, paused } = await crash(mode);
  const categories = () => { const store = openPlacesStore(join(path, 'places.db')); try { return new PlacesService(store, { ownerKey }).listCategories().filter(c => c.name === 'Crash Category'); } finally { store.close(); } };
  const expected = mode === 'after-input' ? 1 : 0;
  expect(categories()).toHaveLength(expected);
  const { fixture, executes } = await reopen(path);
  const request = { ...origin(paused.commandId), messageId: paused.messageId, replyToMessageId: paused.replyToMessageId, text: paused.text };
  expect(await fixture.places.input(request)).toBe(true);
  expect(fixture.latest().presentation.text).toMatch(/interrupted.*may or may not have been applied/s);
  expect(executes.filter(action => action === 'create_category')).toHaveLength(0);
  expect(categories()).toHaveLength(expected);
  expect(await fixture.places.input({ ...request, commandId: 'another-update' })).toBe(true);
  expect(executes.filter(action => action === 'create_category')).toHaveLength(0);
  expect(categories()).toHaveLength(expected);
}, 120_000);
