import { fork, execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { SECRET, browserFixture, call, done, toolArgs, toolText, type Phase, type Tool } from './browser-crash-fixture.js';

// SIGKILL acceptance for the native browser tools. Real native application, real on-disk stock-browser gate
// (written through the retained stock-chrome helpers), fictional domain service, scripted faux model.
// Synthetic limits: no Chrome, CDP, Telegram or Tailscale. Kill points are inside the domain service call.

let compiled: string;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
beforeAll(async () => {
  const cache = join(process.cwd(), 'node_modules/.cache'); await mkdir(cache, { recursive: true }); compiled = await mkdtemp(join(cache, 'browser-crash-'));
  await promisify(execFile)(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--skipLibCheck', '--allowJs', '--module', 'nodenext', '--target', 'es2024', '--rootDir', '.', '--outDir', compiled, 'tests/durable/browser-crash-fixture.ts'], { timeout: 120_000 });
  await cp(join(process.cwd(), '.pi'), join(compiled, '.pi'), { recursive: true, force: false, errorOnExist: false, filter: source => !source.endsWith('.ts') });
}, 130_000);
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string | (() => string), ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${typeof what === 'function' ? what() : what}`); await sleep(25); }
}
async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) { const path = join(root, entry.name); if (entry.isDirectory()) out.push(...await files(path)); else out.push(path); }
  return out;
}

async function crash(tool: Tool, phase: Phase) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-crash-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const child = fork(join(process.cwd(), 'tests/durable/browser-crash-worker.mjs'), [compiled, directory, tool, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr!.on('data', chunk => stderr += String(chunk));
  const markers: Array<{ type: string; phase?: string }> = []; child.on('message', m => markers.push(m as any));
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await until(() => { if (child.exitCode !== null) throw new Error(`Worker exited early: ${stderr}`); return markers.find(m => m.type === 'started'); }, () => `worker start (stderr: ${stderr})`, 30_000);
  const paused = await until(() => { if (child.exitCode !== null) throw new Error(`Worker exited early: ${stderr}`); return markers.find(m => m.type === 'paused'); }, () => `pause marker (stderr: ${stderr})`);
  expect(paused.phase).toBe(phase);
  // Kill the host itself before any service result can be committed.
  child.kill('SIGKILL'); expect(await exited).toMatchObject({ signal: 'SIGKILL' });
  return directory;
}

const UNCERTAIN = /interrupt|may or may not|uncertain|unresolved|could not be verified/i;
const cases = (['private_browser_input', 'browser_takeover', 'private_browser_login', 'private_opentable_login'] as Tool[]).flatMap(tool => (['gate', 'after'] as Phase[]).map(phase => [tool, phase] as const));

it.each(cases)('SIGKILL during %s at the %s boundary retains the gate, never re-runs the service and blocks later browser calls', async (tool, phase) => {
  const directory = await crash(tool, phase);
  const session = toolArgs[tool].session as string;
  // State left by the killed host, read without any native application.
  const view = await browserFixture(directory);
  expect(view.serviceCalls()).toEqual([expect.objectContaining({ session, chatId: 42 })]);
  expect(view.effects()).toHaveLength(phase === 'after' ? 1 : 0);
  expect(existsSync(view.gateFile(session))).toBe(true);
  const gate = JSON.parse(await readFile(view.gateFile(session), 'utf8'));
  expect(Object.keys(gate).sort()).toEqual(['launchId', 'purpose', 'requestId', 'version']);

  const fixture = await browserFixture(directory,{actualBlockedRecovery:true});
  cleanup.push(() => fixture.close());
  const recovered: string[] = [], blocked: string[] = [];
  await fixture.open([
    (r: any) => { recovered.push(toolText(r)); return done('RECOVERED'); },
    call(tool, toolArgs[tool]),
    (r: any) => { blocked.push(toolText(r)); return done('BLOCKED_SEEN'); },
  ]);
  await until(() => fixture.finals.includes('RECOVERED') || undefined, 'recovered turn');
  // The authenticated owner is not resumed: the interrupted call reached the model as uncertain, with no new service call.
  expect(recovered).toHaveLength(1); expect(recovered[0]).toMatch(UNCERTAIN); expect(recovered[0]).not.toMatch(/"status":\s*"submitted"/);
  expect(fixture.serviceCalls()).toHaveLength(1); expect(fixture.effects()).toHaveLength(phase === 'after' ? 1 : 0);
  expect(existsSync(fixture.gateFile(session))).toBe(true);
  await expect(fixture.assertUnprotected(session)).rejects.toThrow(/protected input pending/);

  // Re-delivery of the original Telegram update is deduplicated as well.
  await fixture.accept('Sign me in.', 1);
  expect(fixture.serviceCalls()).toHaveLength(1);
  expect(fixture.effects()).toHaveLength(phase === 'after' ? 1 : 0);

  // A distinct source asks for the browser again; the retained gate stops it inside the domain service.
  await fixture.accept('Try the browser again.', 2);
  await until(() => fixture.finals.includes('BLOCKED_SEEN') || undefined, 'blocked turn');
  expect(fixture.serviceCalls()).toHaveLength(2);
  expect(JSON.parse(blocked[0]!)).toEqual({ status: 'browser_blocked' });
  expect(fixture.effects()).toHaveLength(phase === 'after' ? 1 : 0);
  expect(existsSync(fixture.gateFile(session))).toBe(true); // never cleared automatically
  expect(fixture.fatal).toHaveLength(0);

  // The synthetic secret stayed outside the Harness, indexes and model context.
  expect(JSON.stringify(fixture.requests)).not.toContain(SECRET);
  for (const file of await files(fixture.stateDir)) { if ((await stat(file)).size > 5_000_000) continue; expect((await readFile(file)).includes(SECRET), file).toBe(false); }
}, 60_000);
