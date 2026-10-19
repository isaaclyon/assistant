import { afterEach, expect, it, vi } from 'vitest';
import { createToolActivity, toolActivityLabel } from '../../src/durable/tool-activity.js';

afterEach(() => vi.useRealTimers());

it.each([
  ['read', { path: '/repo/src/host.ts' }, 'Read src/host.ts'],
  ['ls', { path: '/repo/src' }, 'Listed src'],
  ['grep', { pattern: 'private phrase', path: '/repo/src' }, 'Searched src'],
  ['find', { pattern: '*.ts', path: '/repo' }, 'Searched files'],
  ['web_search', { query: 'private query' }, 'Searched the web'],
  ['write_stdin', { session_id: 42 }, 'Waited for command'],
  ['bad name\nsecret', {}, 'tool'],
])('labels %s without exposing arguments', (name, args, expected) => {
  expect(toolActivityLabel(name, args, '/repo')).toBe(expected);
});

it('labels patches by file count without patch contents', () => {
  const one = '*** Begin Patch\n*** Update File: /repo/src/host.ts\n-private secret\n*** End Patch';
  expect(toolActivityLabel('apply_patch', { input: one }, '/repo')).toBe('Edited src/host.ts');
  expect(toolActivityLabel('apply_patch', { input: '*** Update File: a\n*** Add File: b' }, '/repo')).toBe('Edited 2 files');
});

it.each([
  ['git status --short', 'Checked Git status'], ['git diff --stat', 'Reviewed changes'], ['git log -5', 'Inspected Git history'],
  ['rg -n needle src', 'Searched files'], ["sed -n '1,80p' x", 'Read files'], ['npm test', 'Ran tests'],
  ['npm run check', 'Ran project checks'], ['npm run build', 'Built the project'], ['deploy --token secret', 'Ran command'],
])('maps command %s', (cmd, expected) => expect(toolActivityLabel('exec_command', { cmd }, '/repo')).toBe(expected));

it('coalesces changes into one-second edits and cancels pending edits on finish', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => 42), edit = vi.fn(async (_t: unknown, _id: number, _text: string) => undefined), remove = vi.fn(async () => undefined);
  const a = createToolActivity({ port: { send, edit, remove }, target: { chatId: 123 } });
  a.start('first', 'read', {}); await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  a.end('first', false); a.start('second', 'read', {});
  await vi.advanceTimersByTimeAsync(999); expect(edit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(edit).toHaveBeenCalledTimes(1);
  expect(edit.mock.calls[0]![2]).toContain('2 tools');
  a.end('second', false); await a.finish();
  await vi.advanceTimersByTimeAsync(1000);
  expect(edit).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith({ chatId: 123 }, 42);
});
