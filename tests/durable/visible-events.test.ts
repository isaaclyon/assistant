import { expect, test, vi } from 'vitest';

type Listener = (events: any[], context: unknown) => Promise<void>;
const watches: Array<{ cid: string; snapshot: any; listener?: Listener; stopped: boolean; end: () => void }> = [];
let snapshots: Record<string, any> = {};
vi.mock('@earendil-works/pi-durable', async importOriginal => ({
  ...(await importOriginal<object>()),
  watchEvents: async (_h: unknown, cid: string) => {
    const closed = Promise.withResolvers<any>();
    const w: any = { cid, snapshot: snapshots[cid] ?? { type: 'snapshot', entries: [], tools: [] }, stopped: false, end: () => closed.resolve({ reason: 'listener_error' }) };
    watches.push(w);
    return { snapshot: w.snapshot, start: (l: Listener) => { w.listener = l; }, stop: async () => { w.stopped = true; closed.resolve({ reason: 'stopped' }); return { reason: 'stopped' }; }, closed: closed.promise };
  },
}));
const { createVisibleEvents } = await import('../../src/durable/visible-events.js');
const { LiveDoc } = await import('@earendil-works/pi-durable');

function setup(epoch = { epoch: 1, epochs: { '1': 'c1' } as Record<string, string> }) {
  const state = { ...epoch };
  const calls: string[] = [];
  const debug = vi.fn();
  const stream = {
    update: vi.fn((_t: unknown, turn: string, text: string) => { calls.push(`update:${turn}:${text}`); }),
    finish: vi.fn(async (_t: unknown, turn: string) => { calls.push(`finish:${turn}`); }),
  };
  const live: any = {};
  const host: any = { runtime: { root: { id: 'root' }, harness: { snapshot: async (token: unknown) => token === LiveDoc ? live : state } } };
  const config: any = { transport: { allowedUserId: 42 } };
  const real = createVisibleEvents({ host: () => host, config, stream, debug });
  const visible = { ...real, attach: (cid: string) => real.attach(cid as never) };
  const emit = (i: number, ...events: any[]) => watches[i]!.listener!(events, {});
  return { state, live, calls, debug, stream, visible, emit, config, host };
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
  // Queued publications from the completed generation must not rearm previews.
  await emit(0, { type: 'turn_start' }, { type: 'message_start', message: asst([{ type: 'text', text: 'stale' }]) });
  expect(calls.at(-1)).toBe('final');
  await emit(1, { type: 'turn_start' }, { type: 'message_start', message: asst([{ type: 'text', text: 'two' }]) });
  expect(calls.at(-1)).toBe('update:2:1:two');
  await visible.finish();
  expect(stream.finish).toHaveBeenCalledTimes(2);
});

test('a final before the first event drops the entire delayed turn and observes the next generation', async () => {
  reset();
  const { visible, emit, stream } = setup();
  await visible.attach('c1');
  await visible.finish();
  await emit(0, { type: 'turn_start' }, { type: 'message_start', message: asst([{ type: 'text', text: 'already delivered' }]) });
  expect(stream.update).not.toHaveBeenCalled();
  await emit(1, { type: 'turn_start' }, { type: 'message_start', message: asst([{ type: 'text', text: 'next response' }]) });
  expect(stream.update.mock.calls.map(call => call[2])).toEqual(['next response']);
  await visible.close();
});

test('refresh after final keeps a queued generation current partial', async () => {
  reset();
  const { visible, stream } = setup();
  await visible.attach('c1');
  snapshots.c1 = { generation: { message: asst([{ type: 'text', text: 'next partial' }]) } };
  await visible.finish();
  expect(watches[0]!.stopped).toBe(true);
  expect(stream.update.mock.calls.map(call => call[2])).toEqual(['next partial']);
  await visible.close();
});

test('a closed watch settles its preview and final refresh restores observation', async () => {
 reset();const {visible,emit,stream}=setup();
 await visible.attach('c1');
 await emit(0,{type:'turn_start'},{type:'message_start',message:asst([{type:'text',text:'partial'}])});
 watches[0]!.end();await Promise.resolve();
 await visible.finish();
 expect(stream.finish).toHaveBeenCalledTimes(1);
 expect(watches).toHaveLength(2);
 await emit(1,{type:'turn_start'},{type:'message_start',message:asst([{type:'text',text:'next'}])});
 expect(stream.update.mock.calls.map(call=>call[2])).toEqual(['partial','next']);
 await visible.close();
});


test('recipient previews omit proactive runs and recovered partials, while human text and debug stay available', async () => {
 reset();
 snapshots.c1={type:'snapshot',entries:[],tools:[],run:{inputs:['job']},generation:{attempt:1,message:asst([{type:'text',text:'NO_REPLY'}])}};
 const s=setup();s.config.jobsRole='recipient';
 (s.state as any).sources={job:{proactive:true},human:{proactive:false}};
 s.host.runtime.harness.submission=async(id:string)=>({status:async()=>({requestId:id})});
 await s.visible.attach('c1');expect(s.stream.update).not.toHaveBeenCalled();
 s.live.run={inputs:['job']};
 await s.emit(0,{type:'run_start',inputs:['job']},{type:'turn_start'},{type:'message_start',message:asst([{type:'text',text:'SCHEDULED'}])});
 expect(s.stream.update).not.toHaveBeenCalled();
 s.live.run={inputs:['human']};
 await s.emit(0,{type:'run_end',inputs:['job']},{type:'run_start',inputs:['human']},{type:'turn_start'},{type:'message_start',message:asst([{type:'text',text:'Human visible'}])});
 expect(s.stream.update.mock.calls.map(call=>call[2])).toEqual(['Human visible']);
 expect(s.debug).toHaveBeenCalledWith('durable run',{event:'run_start',inputs:1});
 await s.visible.close();
});

test('a proactive follow-up joining after tools suppresses previews without another run_start', async () => {
 reset();
 snapshots.c1={type:'snapshot',entries:[],tools:[],run:{inputs:['human']}};
 const s=setup();s.config.jobsRole='recipient';
 (s.state as any).sources={job:{proactive:true},human:{proactive:false}};
 s.host.runtime.harness.submission=async(id:string)=>({status:async()=>({requestId:id})});
 s.live.run={inputs:['human']};
 await s.visible.attach('c1');
 await s.emit(0,{type:'run_start',inputs:['human']},{type:'turn_start'},{type:'message_start',message:asst([{type:'text',text:'Before tools'}])});
 expect(s.stream.update.mock.calls.map(call=>call[2])).toEqual(['Before tools']);
 // pi-durable extends this run's input list at the post-tools boundary.
 // The atomic attach snapshot stays unchanged and no run_start is emitted.
 s.live.run.inputs.push('job');
 await s.emit(0,{type:'turn_start'},{type:'message_start',message:asst([])},{type:'message_update',changes:[{type:'text_start',contentIndex:0,block:{type:'text',text:'NO_REPLY'}}]});
 expect(s.stream.update.mock.calls.map(call=>call[2])).toEqual(['Before tools']);
 // New human runs rearm preview eligibility.
 s.live.run={inputs:['human']};
 await s.emit(0,{type:'run_end',inputs:['human','job']},{type:'run_start',inputs:['human']},{type:'turn_start'},{type:'message_start',message:asst([{type:'text',text:'Later human'}])});
 expect(s.stream.update.mock.calls.map(call=>call[2])).toEqual(['Before tools','Later human']);
 await s.visible.close();
});

test('recipient watch overflow and unreadable source authority keep proactive partials hidden', async () => {
 reset();
 const s=setup();s.config.jobsRole='recipient';
 (s.state as any).sources={job:{proactive:true},human:{proactive:false}};
 s.host.runtime.harness.submission=async(id:string)=>({status:async()=>({requestId:id})});
 s.live.run={inputs:['human']};
 await s.visible.attach('c1');
 await s.emit(0,{type:'run_start',inputs:['human']},{type:'message_start',message:asst([{type:'text',text:'Human'}])});
 s.live.run={inputs:['job']};
 await s.emit(0,{type:'snapshot',run:{inputs:['job']},generation:{message:asst([{type:'text',text:'NO_REPLY'}])}},{type:'message_update',changes:[{type:'text_delta',contentIndex:0,delta:' LATE'}]});
 expect(s.stream.update.mock.calls.map(call=>call[2])).toEqual(['Human']);
 s.host.runtime.harness.submission=async()=>{throw new Error('unavailable');};
 s.live.run={inputs:['human']};
 await s.emit(0,{type:'run_start',inputs:['human']},{type:'message_start',message:asst([{type:'text',text:'Unknown'}])});
 expect(s.stream.update.mock.calls.map(call=>call[2])).toEqual(['Human']);
 await s.visible.close();
});

function withActivity(s: ReturnType<typeof setup>, intervalMs = 1000) {
  const log: string[] = [];
  const activity = {
    send: vi.fn(async (_t: unknown, text: string) => { log.push(`send:${text}`); return 77; }),
    edit: vi.fn(async (_t: unknown, id: number, text: string) => { log.push(`edit:${id}:${text}`); }),
    remove: vi.fn(async (_t: unknown, id: number) => { log.push(`remove:${id}`); }),
  };
  const real = createVisibleEvents({ host: () => s.host, config: s.config, stream: s.stream, debug: s.debug, activity, cwd: '/repo', activityIntervalMs: intervalMs });
  return { ...real, attach: (cid: string) => real.attach(cid as never), activity, log };
}
const toolStart = (id: string, toolName: string, args: any) => ({ type: 'tool_execution_start', toolCallId: id, toolName, args });
const toolEnd = (id: string, toolName: string, isError = false) => ({ type: 'tool_execution_end', toolCallId: id, toolName, entry: { message: { isError } } });

test('native tool events show friendly labels, coalesce edits per second and remove the message at run end', async () => {
  reset(); vi.useFakeTimers();
  try {
    const s = setup(); const v = withActivity(s);
    await v.attach('c1');
    await s.emit(0, { type: 'run_start', inputs: [] }, toolStart('a', 'read', { path: '/repo/src/host.ts' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(v.activity.send).toHaveBeenCalledTimes(1);
    expect(v.log[0]).toContain('⏳ Read src/host.ts');
    await s.emit(0, toolEnd('a', 'read'), toolStart('b', 'bash', { command: 'deploy --token extremely-secret' }), { type: 'tool_execution_update', toolCallId: 'b', toolName: 'bash', output: { set: 'RAW OUTPUT' } });
    await vi.advanceTimersByTimeAsync(999);
    expect(v.activity.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(v.activity.edit).toHaveBeenCalledTimes(1);
    const text = v.log.join('\n');
    expect(text).toContain('▸ Read src/host.ts'); expect(text).toContain('⏳ Ran command'); expect(text).toContain('2 tools');
    for (const bad of ['extremely-secret', 'RAW OUTPUT', 'deploy']) expect(text).not.toContain(bad);
    await s.emit(0, toolEnd('b', 'bash', true), { type: 'run_end', inputs: [] });
    expect(v.activity.remove).toHaveBeenCalledWith({ chatId: expect.anything() }, 77);
    await vi.advanceTimersByTimeAsync(2000);
    expect(v.activity.edit).toHaveBeenCalledTimes(1);
    await v.close();
  } finally { vi.useRealTimers(); }
});

test('tool activity follows preview authority: proactive runs stay hidden and nested calls are ignored', async () => {
  reset();
  snapshots.c1 = { type: 'snapshot', entries: [], tools: [], run: { inputs: ['job'] } };
  const s = setup(); s.config.jobsRole = 'recipient';
  (s.state as any).sources = { job: { proactive: true }, human: { proactive: false } };
  s.host.runtime.harness.submission = async (id: string) => ({ status: async () => ({ requestId: id }) });
  const v = withActivity(s);
  await v.attach('c1');
  s.live.run = { inputs: ['job'] };
  await s.emit(0, { type: 'run_start', inputs: ['job'] }, toolStart('x', 'read', { path: 'a' }));
  expect(v.activity.send).not.toHaveBeenCalled();
  s.live.run = { inputs: ['human'] };
  await s.emit(0, { type: 'run_end', inputs: ['job'] }, { type: 'run_start', inputs: ['human'] }, toolStart('p/nested', 'read', { path: 'a' }));
  expect(v.activity.send).not.toHaveBeenCalled();
  await s.emit(0, toolStart('y', 'web_search', { query: 'private query' }));
  await vi.waitFor(() => expect(v.log[0]).toContain('Searched the web'));
  expect(v.log.join('')).not.toContain('private query');
  await v.close();
});

test('activity port failure never affects text previews; epoch change and finish remove the message', async () => {
  reset();
  const s = setup({ epoch: 1, epochs: { '1': 'c1' } }); const v = withActivity(s);
  v.activity.send.mockRejectedValueOnce(new Error('network'));
  await v.attach('c1');
  await s.emit(0, toolStart('a', 'ls', { path: '/repo/src' }), { type: 'turn_start' }, { type: 'message_start', message: asst([{ type: 'text', text: 'Still streams' }]) });
  await vi.waitFor(() => expect(v.activity.send).toHaveBeenCalled());
  expect(s.stream.update.mock.calls.map(c => c[2])).toEqual(['Still streams']);
  await s.emit(0, toolStart('b', 'ls', { path: '/repo' }));
  await v.close();
  // A new epoch replaces the observer and cleans the old activity message.
  reset(); const s2 = setup({ epoch: 1, epochs: { '1': 'c1' } }); const v2 = withActivity(s2);
  await v2.attach('c1');
  await s2.emit(0, toolStart('a', 'read', { path: 'a.ts' }));
  await vi.waitFor(() => expect(v2.activity.send).toHaveBeenCalled());
  s2.state.epoch = 2; s2.state.epochs['2'] = 'c2';
  await v2.attach('c2');
  expect(v2.activity.remove).toHaveBeenCalledWith(expect.anything(), 77);
  await v2.close();
});

test('full profiles keep child completion previews and activity hidden when scheduled jobs are disabled', async () => {
 reset(); snapshots.c1={type:'snapshot',entries:[],tools:[],run:{inputs:['child']},generation:{message:asst([{type:'text',text:'CHILD PARTIAL'}])}};
 const s=setup();s.config.jobsRole='disabled';s.config.capabilityProfile='durable-personal-emma';
 (s.state as any).sources={child:{proactive:true},human:{proactive:false}};
 s.host.runtime.harness.submission=async(id:string)=>({status:async()=>({requestId:id})});
 const v=withActivity(s);await v.attach('c1');s.live.run={inputs:['child']};
 await s.emit(0,{type:'run_start',inputs:['child']},toolStart('x','bash',{command:'npm test'}),{type:'message_start',message:asst([{type:'text',text:'CHILD'}])});
 expect(s.stream.update).not.toHaveBeenCalled();expect(v.activity.send).not.toHaveBeenCalled();
 s.live.run={inputs:['human']};await s.emit(0,{type:'run_end',inputs:['child']},{type:'run_start',inputs:['human']},{type:'message_start',message:asst([{type:'text',text:'HUMAN'}])});
 expect(s.stream.update.mock.calls.map(call=>call[2])).toEqual(['HUMAN']);await v.close();
});
