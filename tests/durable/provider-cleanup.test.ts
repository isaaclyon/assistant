import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createNativeProvider, ScopedCredentialStore } from '../../src/durable/provider.js';

const dirs: string[] = [];
const unregister: Array<() => void> = [];
afterEach(async () => { vi.restoreAllMocks(); unregister.splice(0).forEach(f => f()); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

async function open() {
  const dir = await mkdtemp(join(tmpdir(), 'native-cleanup-')); dirs.push(dir);
  const credentialPath = join(dir, 'auth.json'), settingsPath = join(dir, 'settings.json');
  await writeFile(credentialPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
  await writeFile(settingsPath, JSON.stringify({ version: 1, account: 'test', provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'low' }), { mode: 0o600 });
  const calls: Array<{ api: string; options: unknown }> = [];
  const catalog = openaiCodexProvider();
  const provider = { ...catalog,
    stream: (_m: unknown, _c: unknown, o: unknown) => { calls.push({ api: 'stream', options: o }); return 'S'; },
    streamSimple: (_m: unknown, _c: unknown, o: unknown) => { calls.push({ api: 'simple', options: o }); return 'SS'; } } as unknown as typeof catalog;
  const native = await createNativeProvider({ credentialPath, settingsPath, account: 'test', provider });
  return { native, calls, credentialPath };
}
function spy(fail = false) {
  const ids: Array<string | undefined> = [];
  unregister.push(registerSessionResourceCleanup(id => { ids.push(id); if (fail) throw new Error('boom'); }));
  return ids;
}

test('close cleans only sessions seen through stream and streamSimple, once, preserving arguments', async () => {
  const ids = spy();
  const a = await open(), b = await open();
  const options = { sessionId: 'a-1', marker: 1 };
  expect((a.native.provider.stream as any)('m', 'c', options)).toBe('S');
  expect((a.native.provider.streamSimple as any)('m', 'c', { sessionId: 'a-2' })).toBe('SS');
  (a.native.provider.stream as any)('m', 'c', {}); (a.native.provider.stream as any)('m', 'c', { sessionId: '' }); (a.native.provider.streamSimple as any)('m', 'c');
  (b.native.provider.stream as any)('m', 'c', { sessionId: 'b-1' });
  expect(a.calls[0]!.options).toBe(options);
  a.native.close(); a.native.close();
  expect(ids.sort()).toEqual(['a-1', 'a-2']);
  b.native.close();
  expect(ids.sort()).toEqual(['a-1', 'a-2', 'b-1']);
  expect(ids).not.toContain(undefined);
});

test('sessionless use cleans nothing', async () => {
  const ids = spy();
  const a = await open();
  (a.native.provider.streamSimple as any)('m', 'c', {});
  a.native.close();
  expect(ids).toEqual([]);
});

test('cleanup failure closes credentials and still attempts every owned session', async () => {
  const ids = spy(true);
  const a = await open();
  const closeCredentials = vi.spyOn(ScopedCredentialStore.prototype, 'close');
  (a.native.provider.stream as any)('m', 'c', { sessionId: 'x' });
  (a.native.provider.streamSimple as any)('m', 'c', { sessionId: 'y' });
  expect(() => a.native.close()).toThrow(AggregateError);
  expect(ids.sort()).toEqual(['x', 'y']);
  expect(closeCredentials).toHaveBeenCalledOnce();
  expect(() => a.native.close()).not.toThrow();
  expect(ids).toEqual(['x', 'y']);
});
