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
test('preview failures are best effort and do not stall later updates', async () => {
  const errors = vi.fn(); let calls = 0;
  const stream = createPreviewStream({ authorize: () => true, intervalMs: 10, onError: errors, send: async () => { if (++calls === 1) throw new Error('down'); } });
  stream.update(target, 't', 'x'); await vi.advanceTimersByTimeAsync(0);
  stream.update(target, 't', 'xy'); await vi.advanceTimersByTimeAsync(50);
  expect(errors).toHaveBeenCalledTimes(1); expect(calls).toBe(2);
});
