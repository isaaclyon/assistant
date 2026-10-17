import { expect, test, vi } from 'vitest';

type Listener = (events: any[], context: unknown) => Promise<void>;
const watches: Array<{ cid: string; snapshot: any; listener?: Listener; stopped: boolean }> = [];
let snapshots: Record<string, any> = {};
vi.mock('@earendil-works/pi-durable', async importOriginal => ({
  ...(await importOriginal<object>()),
  watchEvents: async (_h: unknown, cid: string) => {
    const w: any = { cid, snapshot: snapshots[cid] ?? { type: 'snapshot', entries: [], tools: [] }, stopped: false };
    watches.push(w);
    return { snapshot: w.snapshot, start: (l: Listener) => { w.listener = l; }, stop: async () => { w.stopped = true; return { reason: 'stopped' }; }, closed: new Promise(() => {}) };
  },
}));
const { createVisibleEvents } = await import('../../src/durable/visible-events.js');

function setup(epoch = { epoch: 1, epochs: { '1': 'c1' } as Record<string, string> }) {
  const state = { ...epoch };
  const calls: string[] = [];
  const debug = vi.fn();
  const stream = {
    update: vi.fn((_t: unknown, turn: string, text: string) => { calls.push(`update:${turn}:${text}`); }),
    finish: vi.fn(async (_t: unknown, turn: string) => { calls.push(`finish:${turn}`); }),
  };
  const host: any = { runtime: { root: { id: 'root' }, harness: { snapshot: async () => state } } };
  const config: any = { transport: { allowedUserId: 42 } };
  const real = createVisibleEvents({ host: () => host, config, stream, debug });
  const visible = { ...real, attach: (cid: string) => real.attach(cid as never) };
  const emit = (i: number, ...events: any[]) => watches[i]!.listener!(events, {});
  return { state, calls, debug, stream, visible, emit };
}
const reset = () => { watches.length = 0; snapshots = {}; };
const asst = (content: any[]) => ({ role: 'assistant', content });

test('streams only assistant text, never thinking, tool arguments or tool output', async () => {
  reset();
  const { visible, emit, stream, debug } = setup();
  await visible.attach('c1');
  await emit(0,
    { type: 'turn_start' },
    { type: 'message_start', message: asst([]) },
    { type: 'message_update', usage: {}, changes: [
      { type: 'thinking_start', contentIndex: 0, block: { type: 'thinking', thinking: 'SECRET' } },
      { type: 'thinking_delta', contentIndex: 0, delta: 'SECRET2' },
      { type: 'toolcall_start', contentIndex: 1, block: { type: 'toolCall', name: 'bash', arguments: { x: 'ARGS' } } },
      { type: 'toolcall_delta', contentIndex: 1, path: ['x'], delta: 'ARGS' },
      { type: 'text_start', contentIndex: 2, block: { type: 'text', text: 'Hel' } },
      { type: 'text_delta', contentIndex: 2, delta: 'lo' },
    ] },
    { type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: { cmd: 'rm ARGS' } },
    { type: 'tool_execution_update', toolCallId: 'x', toolName: 'bash', output: { set: 'OUTPUT' } },
    { type: 'tool_execution_end', toolCallId: 'x', toolName: 'bash weird name\nwith secret' },
    { type: 'task_failed', taskId: 't', kind: 'k', message: 'RAW ERROR' });
  expect(stream.update.mock.calls.map(c => c[2])).toEqual(['Hello']);
  const dump = JSON.stringify([...stream.update.mock.calls, ...debug.mock.calls]);
  for (const bad of ['SECRET', 'ARGS', 'OUTPUT', 'RAW ERROR', 'secret']) expect(dump).not.toContain(bad);
  expect(debug).toHaveBeenCalledWith('durable tool', { event: 'start', tool: 'bash' });
  expect(debug).toHaveBeenCalledWith('durable tool', { event: 'end', tool: 'tool' });
});

test('snapshot partial generation replays visible text only', async () => {
  reset();
  snapshots.c1 = { type: 'snapshot', entries: [], tools: [], generation: { attempt: 1, message: asst([{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'text', text: 'Partial' }]) } };
  const { visible, stream } = setup();
  await visible.attach('c1');
  expect(stream.update).toHaveBeenCalledTimes(1);
  expect(stream.update.mock.calls[0]![2]).toBe('Partial');
});

test('only the current epoch conversation can become the observer; duplicate attach is idempotent', async () => {
  reset();
  const { visible, state } = setup({ epoch: 2, epochs: { '1': 'old', '2': 'c2' } });
  await visible.attach('old');
  expect(watches).toHaveLength(0);
  await visible.attach('c2'); await visible.attach('c2');
  expect(watches).toHaveLength(1);
  state.epoch = 3; state.epochs['3'] = 'c3';
  await visible.attach('c2'); // replayed source of a now-old conversation
  expect(watches).toHaveLength(1); expect(watches[0]!.stopped).toBe(false);
  await visible.attach('c3');
  expect(watches).toHaveLength(2); expect(watches[0]!.stopped).toBe(true);
  await visible.attach('c2');
  expect(watches[1]!.stopped).toBe(false);
  await visible.close();
  expect(watches[1]!.stopped).toBe(true);
});

test('finish settles the preview before the final and later events of that turn are dropped; next turn rearms', async () => {
  reset();
  const { visible, emit, calls, stream } = setup();
  await visible.attach('c1');
  await emit(0, { type: 'turn_start' }, { type: 'message_start', message: asst([{ type: 'text', text: 'one' }]) });
  await visible.finish();
  calls.push('final');
  await emit(0, { type: 'message_update', usage: {}, changes: [{ type: 'text_delta', contentIndex: 0, delta: ' late' }] });
  expect(calls).toEqual(['update:1:1:one', 'finish:1:1', 'final']);
  await emit(0, { type: 'turn_start' }, { type: 'message_start', message: asst([{ type: 'text', text: 'two' }]) });
  expect(calls.at(-1)).toBe('update:1:2:two');
  await visible.finish();
  expect(stream.finish).toHaveBeenCalledTimes(2);
});
