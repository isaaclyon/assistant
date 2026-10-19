import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createPreviewStream } from '../../src/durable/telegram-stream.js';
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const target = { chatId: 42 };
test('coalesces to latest visible text, bounds length and drops late updates after final', async () => {
  const sent: string[] = [];
  const stream = createPreviewStream({ authorize: t => t.chatId === 42 && t.threadId === undefined, intervalMs: 1000, maxChars: 10, send: async (_t, text) => { sent.push(text); } });
  stream.update(target, 'a', 'one'); await vi.advanceTimersByTimeAsync(0);
  stream.update(target, 'a', 'two'); stream.update(target, 'a', 'three words here'); await vi.advanceTimersByTimeAsync(1000);
  expect(sent).toEqual(['one', '…ords here']);
  await stream.finish(target, 'a');
  stream.update(target, 'a', 'late'); await vi.advanceTimersByTimeAsync(5000);
  expect(sent).toHaveLength(2);
  stream.update({ chatId: 43 }, 'b', 'other chat'); stream.update({ chatId: 42, threadId: 1 }, 'b', 'thread'); await vi.advanceTimersByTimeAsync(5000);
  expect(sent).toHaveLength(2);
});
test('finish cannot rearm a pending preview when its in-flight send completes', async () => {
  const gate = Promise.withResolvers<void>(), sent: string[] = [];
  const stream = createPreviewStream({ authorize: () => true, intervalMs: 1000,
    send: async (_target, text) => { sent.push(text); await gate.promise; } });
  stream.update(target, 'a', 'first partial');
  stream.update(target, 'a', 'later partial');
  const finishing = stream.finish(target, 'a');
  gate.resolve(); await finishing;
  sent.push('FINAL');
  await vi.advanceTimersByTimeAsync(5000);
  expect(sent).toEqual(['first partial', 'FINAL']);
});
test('finishing an older in-flight turn preserves a newer turn slot', async () => {
  const gate = Promise.withResolvers<void>(), sent: string[] = [];
  const stream = createPreviewStream({ authorize: () => true, intervalMs: 1000,
    send: async (_target, text) => { sent.push(text); if (text === 'old') await gate.promise; } });
  stream.update(target, 'a', 'old');
  const finishing = stream.finish(target, 'a');
  stream.update(target, 'b', 'new');
  gate.resolve(); await finishing;
  stream.update(target, 'b', 'newest');
  expect(sent).toEqual(['old', 'new']);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent).toEqual(['old', 'new', 'newest']);
  await stream.finish(target, 'b');
});
test('preview failures are best effort and do not stall later updates', async () => {
  const errors = vi.fn(); let calls = 0;
  const stream = createPreviewStream({ authorize: () => true, intervalMs: 10, onError: errors, send: async () => { if (++calls === 1) throw new Error('down'); } });
  stream.update(target, 't', 'x'); await vi.advanceTimersByTimeAsync(0);
  stream.update(target, 't', 'xy'); await vi.advanceTimersByTimeAsync(50);
  expect(errors).toHaveBeenCalledTimes(1); expect(calls).toBe(2);
});
