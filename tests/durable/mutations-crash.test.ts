import { fork, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PlacesApplication } from '../../src/places-application.js';
import { Bindings, context } from '../../src/durable/ingress.js';
import { done, mutationsFixture, seededEventId, toolText, type MutationsFixture } from './mutations-crash-fixture.js';

// SIGKILL acceptance for C4 guarded mutations. Real native application (DurableHost, production native modules,
// canonical places SQLite) with a fake gog executable that persists a remote calendar file. The worker is killed
// together with any paused gog child at the transport effect, before or after the remote state changes.
// Synthetic limits: no Google network/OAuth, no real Telegram, a scripted faux model, kill points are at the
// gog process boundary (Calendar) or the domain confirmPrepared call (places), not at arbitrary instructions.

let compiled: string;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
beforeAll(async () => {
  const cache = join(process.cwd(), 'node_modules/.cache'); await mkdir(cache, { recursive: true }); compiled = await mkdtemp(join(cache, 'mutations-crash-'));
  await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck', '--allowJs', '--module', 'nodenext', '--target', 'es2024', '--rootDir', '.', '--outDir', compiled, 'src/places-application.ts', 'tests/durable/mutations-crash-fixture.ts'], { timeout: 120_000 });
  // Copy assets loaded by filename as well as the modules followed by tsc.
  await cp(join(process.cwd(), '.pi'), join(compiled, '.pi'), { recursive: true, force: false, errorOnExist: false, filter: source => !source.endsWith('.ts') });
}, 130_000);
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string | (() => string), ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${typeof what === 'function' ? what() : what}`); await sleep(25); }
}
const kill = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

type Scenario = 'calendar-create' | 'calendar-update' | 'calendar-delete' | 'places-delete';
type Phase = 'before' | 'after';
async function crash(scenario: Scenario, phase: Phase) {
  const directory = await mkdtemp(join(tmpdir(), 'mutations-crash-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const child = fork(join(process.cwd(), 'tests/durable/mutations-crash-worker.mjs'), [compiled, directory, scenario, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => stderr += String(chunk));
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let gogPid: number | undefined;
  const stopGog = () => { if (gogPid !== undefined) { kill(gogPid); gogPid = undefined; } };
  cleanup.push(async () => { try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; } finally { stopGog(); } });
  const marker = join(directory, 'paused.json');
  const paused = await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited early: ${stderr}`);
    if (!existsSync(marker)) return undefined;
    try { return JSON.parse(await readFile(marker, 'utf8')) as { pid: number; method: string; phase: string }; }
    catch (error) { if (error instanceof SyntaxError) return undefined; throw error; } // The file may be visible before its write finishes.
  }, () => `pause marker (worker stderr: ${stderr})`);
  if (paused.method.startsWith('events.')) gogPid = paused.pid;
  // Stop the host first: killing its transport first could let it reconcile and
  // commit a result before SIGKILL, which would weaken this recovery test.
  child.kill('SIGKILL'); expect(await exited).toMatchObject({ signal: 'SIGKILL' });
  stopGog();
  const ready = existsSync(join(directory, 'ready.json')) ? JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')) as { messageId: number; data: string; updateId: number } : undefined;
  return { directory, paused, ready };
}
async function reopen(directory: string, responses: any[]) {
  const confirms: unknown[] = []; const original = PlacesApplication.prototype.confirmPrepared;
  (PlacesApplication.prototype as any).confirmPrepared = function (prepared: unknown) { confirms.push(prepared); return (original as any).call(this, prepared); };
  const fixture = await mutationsFixture(directory, { seed: false });
  cleanup.push(async () => { (PlacesApplication.prototype as any).confirmPrepared = original; await fixture.close(); });
  await fixture.open(responses);
  return { fixture, confirms };
}
const writes = (s: MutationsFixture) => s.calls().filter(c => c.write);
const UNCERTAIN = /interrupt|may or may not|uncertain|unresolved|could not be verified/i;
const eventOf = async (s: MutationsFixture, id: string) => (await s.remote()).events[Object.keys((await s.remote()).events).find(k => k.endsWith(`/${id}`)) ?? ''];
const shownSince = (s: MutationsFixture, count: number, toasts: number) => [...s.presentations.slice(count).map(p => p.value.text), ...s.toasts.slice(toasts), ...s.finals].join('\n');
const bumpEpoch = async (s: MutationsFixture) => {
  const host = (s.app() as any).host; const id = host.runtime.root.id;
  await host.runtime.root.commit(async (tx: any) => { (await tx.doc(Bindings, id)).epoch++; }, context);
};

it.each([['calendar-create', 'before'], ['calendar-create', 'after'], ['calendar-update', 'before'], ['calendar-update', 'after']] as const)('SIGKILL %s %s the Calendar transport effect never repeats the write on recovery or re-sent updates', async (scenario, phase) => {
  const kind = scenario === 'calendar-create' ? 'create' : 'update';
  const { directory } = await crash(scenario, phase);
  const s0 = await mutationsFixture(directory, { seed: false });
  expect(writes(s0)).toHaveLength(1); expect(s0.effects()).toHaveLength(phase === 'after' ? 1 : 0);
  const baseline = s0.calls().length; const remoteBefore = await s0.remote();
  const results: string[] = [];
  const { fixture: s } = await reopen(directory, [(r: any) => { results.push(toolText(r)); return done('RECOVERED'); }, () => done('AGAIN')]);
  await until(() => s.finals.includes('RECOVERED') || undefined, 'recovered turn');
  // The same original update is delivered again, then another update arrives.
  await s.accept('Please change my calendar.', 1); await s.accept('Please try again.', 2);
  await until(() => s.finals.includes('AGAIN') || undefined, 'second update turn');
  expect(writes(s)).toHaveLength(1); expect(s.effects()).toHaveLength(phase === 'after' ? 1 : 0);
  expect(s.calls().slice(baseline).some(c => c.method === 'events.get')).toBe(true); // The lost result actually needs reconciliation.
  expect(s.calls().slice(baseline).every(c => !c.write && c.readonly)).toBe(true);
  const remote = await s.remote(); expect(Object.keys(remote.events)).toHaveLength(Object.keys(remoteBefore.events).length);
  expect(results).toHaveLength(1);
  const createdKey = Object.keys(remote.events).find(k => !k.endsWith(seededEventId));
  const event = kind === 'create' ? remote.events[createdKey ?? ''] : await eventOf(s, seededEventId);
  const claimsSuccess = /"ok":\s*true/.test(results[0]!);
  if (phase === 'before') {
    expect(claimsSuccess).toBe(false); expect(results[0]).toMatch(UNCERTAIN);
    if (kind === 'create') expect(Object.keys(remote.events).some(k => !k.endsWith(seededEventId))).toBe(false); else expect(event.summary).toBe('Seeded Event');
  } else if (claimsSuccess) {
    expect(event?.summary).toBe(kind === 'create' ? 'Crash Event' : 'Updated Crash Event'); // success only when the remote proves it
  } else expect(results[0]).toMatch(UNCERTAIN);
}, 120_000);

it.each(['before', 'after'] as const)('SIGKILL %s the Calendar delete effect never repeats it when the exact callback is resent', async phase => {
  const { directory, ready } = await crash('calendar-delete', phase);
  const s0 = await mutationsFixture(directory, { seed: false });
  expect(writes(s0)).toHaveLength(1); expect(s0.effects()).toHaveLength(phase === 'after' ? 1 : 0);
  const baseline = s0.calls().length;
  const { fixture: s } = await reopen(directory, []);
  const shown = s.presentations.length, toasts = s.toasts.length;
  await s.callback(ready!.messageId, ready!.data, ready!.updateId); // exact original callback identity
  await s.callback(ready!.messageId, ready!.data, ready!.updateId + 1); // another update, same button
  await sleep(300);
  expect(writes(s)).toHaveLength(1); expect(s.effects()).toHaveLength(phase === 'after' ? 1 : 0);
  expect(s.calls().slice(baseline).some(c => c.method === 'events.get')).toBe(true);
  expect(s.calls().slice(baseline).every(c => !c.write && c.readonly)).toBe(true);
  const event = await eventOf(s, seededEventId); const text = shownSince(s, shown, toasts);
  expect(event.status).toBe(phase === 'after' ? 'cancelled' : 'confirmed');
  if (phase === 'before') { expect(text).toMatch(/not deleted|interrupt|may or may not|uncertain|could not be verified/i); expect(text).not.toMatch(/event (was|has been) deleted/i); } // read-only reconciliation may prove it unchanged
  else expect(text).toMatch(/delet|interrupt|may or may not|uncertain|could not be verified/i);
  expect(s.fatal).toHaveLength(0);
}, 120_000);

it('/new epoch change after a Calendar delete effect rejects the stale callback with no write or presentation', async () => {
  const { directory, ready } = await crash('calendar-delete', 'after');
  const { fixture: s } = await reopen(directory, []);
  const epoch = async () => ((await (s.app() as any).host.runtime.harness.snapshot(Bindings, (s.app() as any).host.runtime.root.id, context))?.epoch ?? 0) as number;
  const first = await epoch(); await bumpEpoch(s); expect(await epoch()).toBe(first + 1);
  const shown = s.presentations.length, calls = s.calls().length;
  await s.callback(ready!.messageId, ready!.data, ready!.updateId); await sleep(300);
  expect(s.presentations.length).toBe(shown); expect(s.calls()).toHaveLength(calls); expect(writes(s)).toHaveLength(1); expect(s.effects()).toHaveLength(1);
}, 120_000);

it.each(['before', 'after'] as const)('SIGKILL %s the places delete effect never re-executes it when the exact callback is resent', async phase => {
  const { directory, ready } = await crash('places-delete', phase);
  const expected = phase === 'after' ? [] : ['Crash Cafe'];
  const names = (s: MutationsFixture) => s.places().map(p => p.name);
  expect(names(await mutationsFixture(directory, { seed: false }))).toEqual(expected);
  const { fixture: s, confirms } = await reopen(directory, []);
  const shown = s.presentations.length, toasts = s.toasts.length;
  await s.callback(ready!.messageId, ready!.data, ready!.updateId); await s.callback(ready!.messageId, ready!.data, ready!.updateId + 1); await sleep(300);
  expect(confirms).toHaveLength(0); expect(names(s)).toEqual(expected);
  expect(shownSince(s, shown, toasts)).toMatch(/interrupt|may or may not|uncertain|could not be verified/i);
  expect(s.fatal).toHaveLength(0);
}, 120_000);

it.each(['before', 'after'] as const)('/new epoch change after a %s-effect places delete crash rejects the stale callback without effects', async phase => {
  const { directory, ready } = await crash('places-delete', phase);
  const expected = phase === 'after' ? [] : ['Crash Cafe'];
  const { fixture: s, confirms } = await reopen(directory, []);
  const epoch = async () => ((await (s.app() as any).host.runtime.harness.snapshot(Bindings, (s.app() as any).host.runtime.root.id, context))?.epoch ?? 0) as number;
  const first = await epoch(); await bumpEpoch(s); expect(await epoch()).toBe(first + 1);
  const shown = s.presentations.length;
  await s.callback(ready!.messageId, ready!.data, ready!.updateId); await sleep(300);
  expect(s.presentations.length).toBe(shown); expect(confirms).toHaveLength(0); expect(s.places().map(p => p.name)).toEqual(expected);
}, 120_000);
