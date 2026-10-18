import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { GoogleCommandError } from '../../.pi/lib/google-operations.js';
import type { NativeConfig } from '../../src/durable/config.js';
import { CALENDAR_TTL_MS, CalendarNative, calendarTransport, createNativeCalendar } from '../../src/durable/calendar.js';
import { createGoogleReadBundle } from '../../src/durable/google-read.js';
import type { DurableHost } from '../../src/durable/host.js';
import { Bindings, context } from '../../src/durable/ingress.js';
import { UiRejectedError, type UiOrigin } from '../../src/durable/telegram-bridge.js';
import type { Presentation } from '../../src/durable/telegram-ui.js';

const ACCOUNT = 'owner@example.com';
type Sent = { messageId: number; text: string; buttons: Array<Array<{ text: string; callback: string }>> };
type Event = Record<string, any>;
const START = { dateTime: '2026-11-02T12:00:00-05:00', timeZone: 'America/New_York' };
const END = { dateTime: '2026-11-02T13:00:00-05:00', timeZone: 'America/New_York' };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-native-'));
  const stateDir = join(dir, 'state');
  const config = {
    version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40),
    resourceRoot: join(dir, 'release'), workspaceCwd: join(dir, 'work'), stateDir,
    capabilityProfile: 'durable-mutations-test', account: 'test', credentialPath: '/x', settingsPath: '/x', jobsRole: 'disabled', idleHours: 0,
    transport: { mode: 'broker', socketPath: '/x.sock', botId: 1, allowedUserId: 2 },
    historyDir: join(stateDir, 'durable'), inboxPath: join(stateDir, 'inbox.db'), runtimeMetadataPath: join(stateDir, 'runtime.json'),
    google: { account: ACCOUNT, gog: { binary: '/synthetic/gog', passwordFile: '/synthetic/pw', home: '/synthetic/home' }, calendarTargets: { account: ACCOUNT, personal: 'personal-id', thingsToDo: 'things-id' } },
  } as NativeConfig;
  const db = await openNodeSqliteDatabase(join(dir, 'native.sqlite'));
  const harness = await Harness.open(await SqliteStorage.open(db), { models: createModels(), registry: createRegistry() }, context);
  const root = await harness.root(context);
  await root.commit(async tx => { const state = await tx.doc(Bindings, root.id); state.epoch = 1; state.epochs['1'] = root.id; state.sources.s1 = { conversationId: root.id, epoch: 1, fingerprint: 'f', chatId: 2, threadId: null, originalAt: 1, principal: 'isaac', proactive: false, envelope: {} } as never; }, context);
  const host = { runtime: { root } } as unknown as DurableHost;

  // Fake Google Calendar.
  const events = new Map<string, Event>();
  const calls: Array<{ method: string; id?: string; body: Event }> = [];
  const control = {
    time: Date.now(), role: 'owner', failPresent: false, receipt: true, etag: 10,
    /** After the write lands, throw as if the response was lost. */
    loseResponse: false, readsFail: false,
    onMethod: undefined as undefined | ((method: string, signal?: AbortSignal) => Promise<void> | void),
  };
  const run = async (_runtime: unknown, args: string[], signal?: AbortSignal) => {
    const method = args[args.indexOf('v3') + 1]!.replace('calendar.', '');
    const params = JSON.parse(args.find(arg => arg.startsWith('--params='))!.slice(9));
    const body = JSON.parse(args.find(arg => arg.startsWith('--body='))?.slice(7) ?? '{}') as Event;
    await control.onMethod?.(method, signal);
    if (method === 'calendarList.get') return { id: params.calendarId, accessRole: control.role };
    if (method === 'events.get') {
      if (control.readsFail) throw new Error('synthetic outage');
      const event = events.get(params.eventId);
      if (!event) throw new GoogleCommandError('NOT_FOUND');
      return structuredClone(event);
    }
    calls.push({ method, ...(params.eventId ? { id: params.eventId } : {}), body });
    if (method === 'events.insert') events.set(body.id, { ...body, etag: `"e${++control.etag}"`, status: 'confirmed' });
    else if (method === 'events.patch') events.set(params.eventId, { ...events.get(params.eventId), ...body, etag: `"e${++control.etag}"` });
    else if (method === 'events.delete') events.set(params.eventId, { id: params.eventId, status: 'cancelled' });
    else throw new Error('unexpected method');
    if (control.loseResponse) throw new Error('synthetic timeout after commit');
    return method === 'events.delete' ? {} : structuredClone(events.get(body.id ?? params.eventId));
  };
  const seed = (id: string, extra: Event = {}) => { events.set(id, { id, etag: '"e1"', status: 'confirmed', summary: 'Lunch', start: START, end: END, ...extra }); };

  const sent: Sent[] = [];
  let next = 100;
  const present = async (_target: unknown, presentation: Presentation) => {
    if (control.failPresent) throw new Error('telegram down');
    const messageId = ++next;
    sent.push({ messageId, text: presentation.text, buttons: (presentation.buttons ?? []) as Sent['buttons'] });
    return { messageId: control.receipt ? messageId : NaN };
  };
  let keys = 0;
  const make = () => createNativeCalendar({ config, host: () => host, present, run, now: () => control.time, randomKey: () => (++keys).toString(16).padStart(32, '0') });
  let calendar = make();
  let counter = 0;
  const origin = (): UiOrigin => ({ commandId: `cmd-${++counter}`, principal: 'isaac', actorId: 2, target: { chatId: 2 } });
  const last = () => sent[sent.length - 1]!;
  let callSeq = 0;
  const tasks = new Map<string, number>();
  const taskId = (callId: string) => { if (!tasks.has(callId)) tasks.set(callId, tasks.size + 1); return tasks.get(callId)!; };
  const taskKey = (callId: string) => String(taskId(callId));
  const api = (callId = `call-${++callSeq}`, conversationId = root.id) => ({ conversationId, callId, taskId: taskId(callId), commit: (fn: never, ctx: never) => root.commit(fn, ctx) });
  async function tool(args: Record<string, unknown>, callId?: string, options: { conversationId?: any; taskId?: number; abortSignal?: AbortSignal; commit?: any } = {}) {
    const registration = calendar.bundle().tools[0]!.tool as unknown as { execute(args: unknown, api: unknown, ctx: unknown): Promise<{ output: Array<{ text: string }>; isError?: boolean }> };
    const base = { ...api(callId, options.conversationId), ...(options.taskId ? { taskId: options.taskId } : {}) };
    const result = await registration.execute(args, options.commit ? { ...base, commit: options.commit } : base, { ...context, ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}) });
    return { ...JSON.parse(result.output[0]!.text), isError: result.isError } as { ok: boolean; result: any; error: { code: string; message: string } | null; isError: boolean };
  }
  const state = () => root.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(CalendarNative, root.id))) as { journal: Record<string, any>; confirmations: Record<string, any> }, context);
  const press = (label: string, message: Sent = last(), request: Partial<UiOrigin & { messageId: number }> = {}) => {
    const button = message.buttons.flat().find(item => item.text === label);
    if (!button) throw new Error(`No button ${label}`);
    return calendar.callback({ ...origin(), messageId: message.messageId, ...request, key: button.callback.slice(3) });
  };
  return {
    dir, config, root, harness, events, calls, control, seed, sent, last, tool, press, origin, state, api, host, taskKey,
    get calendar() { return calendar; },
    reopen: async () => { await calendar.close(); calendar = make(); },
    cleanup: async () => { await calendar.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
let fx: Fixture;
beforeEach(async () => { fx = await setup(); });
afterEach(async () => { await fx.cleanup(); });

const rejected = async (work: Promise<unknown>) => { try { await work; } catch (error) { expect(error).toBeInstanceOf(UiRejectedError); return (error as Error).message; } throw new Error('expected rejection'); };
const draft = { summary: 'Dentist', start: START, end: END };
const requestDelete = (id = 'ev1', etag = '"e1"') => fx.tool({ operation: 'calendar_request_delete', event_id: id, if_etag: etag });
const patches = () => fx.calls.filter(call => call.method === 'events.patch');
const deletes = () => fx.calls.filter(call => call.method === 'events.delete');

describe('schema and registration', () => {
  test('one replay-safe google_workspace tool offers reads plus create, update and request_delete only', () => {
    const tools = fx.calendar.bundle().tools.map(entry => entry.tool as any);
    expect(tools.map(item => item.name)).toEqual(['google_workspace', 'google_places_read']);
    const dispatcher = tools[0];
    expect(dispatcher.replay).toBe('safe');
    expect(dispatcher.parameters.type).toBe('object');
    expect(dispatcher.parameters.anyOf).toBeUndefined();
    const operations: string[] = dispatcher.parameters.properties.operation.enum;
    expect(operations).toEqual(expect.arrayContaining(['calendar_event', 'gmail_search', 'places_details', 'calendar_create', 'calendar_update', 'calendar_request_delete']));
    for (const forbidden of ['calendar_confirm', 'calendar_approve', 'calendar_delete', 'gmail_send']) expect(operations).not.toContain(forbidden);
    for (const field of ['token', 'confirmation_token', 'approval']) expect(Object.keys(dispatcher.parameters.properties)).not.toContain(field);
  });

  test('the earlier read bundle keeps its read-only surface', () => {
    const read = createGoogleReadBundle(fx.config).tools[0]!.tool as any;
    expect(read.parameters.properties.operation.enum).not.toContain('calendar_create');
    expect(read.parameters.properties.operation_key).toBeUndefined();
  });

  test('invalid or extra fields never reach the transport', async () => {
    for (const args of [
      { operation: 'calendar_create', operation_key: 'k', event: { ...draft, attendees: [{ email: 'a@b.c' }] } },
      { operation: 'calendar_create', event: draft },
      { operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"' },
      { operation: 'calendar_request_delete', event_id: 'ev1' },
      { operation: 'calendar_confirm', token: 'x' },
    ]) { const out = await fx.tool(args); expect(out.error?.code).toBe('GOOGLE_INPUT_INVALID'); }
    expect(fx.calls).toHaveLength(0);
    expect(fx.sent).toHaveLength(0);
  });

  test('the transport accepts only fixed Calendar shapes', async () => {
    const seen: string[][] = [];
    const guarded = calendarTransport(async options => { seen.push(options.args); return {}; });
    const runtime = { binary: '/b', passwordFile: '/p', gogHome: '/h' };
    const base = ['--no-input', '--gmail-no-send', '--json', '--account', ACCOUNT];
    const call = (flag: string, method: string, extra: string[] = []) => guarded(runtime, [...base, flag, 'api', 'call', 'calendar', 'v3', `calendar.${method}`, ...extra]);
    await call('--readonly', 'events.get');
    await call('--force', 'events.patch', ['--allow-write']);
    await expect(call('--readonly', 'events.patch')).rejects.toThrow();
    await expect(call('--force', 'events.patch')).rejects.toThrow();
    await expect(call('--force', 'events.list', ['--allow-write'])).rejects.toThrow();
    await expect(guarded(runtime, ['gmail', 'send'])).rejects.toThrow();
    expect(seen).toHaveLength(2);
  });
});

describe('create and update', () => {
  test('creates once with a stable ID and returns the existing event for a repeated operation_key', async () => {
    const first = await fx.tool({ operation: 'calendar_create', operation_key: 'k1', event: draft });
    expect(first).toMatchObject({ ok: true, result: { operation: 'calendar_create', event: { summary: 'Dentist', calendar: 'personal', editable: true } } });
    const again = await fx.tool({ operation: 'calendar_create', operation_key: 'k1', event: draft });
    expect(again.result.event.id).toBe(first.result.event.id);
    expect(fx.calls.filter(call => call.method === 'events.insert')).toHaveLength(1);
    const conflict = await fx.tool({ operation: 'calendar_create', operation_key: 'k1', event: { ...draft, summary: 'Other' } });
    expect(conflict.error?.code).toBe('CALENDAR_OPERATION_CONFLICT');
    expect(fx.calls.filter(call => call.method === 'events.insert')).toHaveLength(1);
    const thing = await fx.tool({ operation: 'calendar_create', calendar: 'things_to_do', operation_key: 'k2', event: draft });
    expect(thing.result.event.calendar).toBe('things_to_do');
    expect(Object.values((await fx.state()).journal).every(entry => entry.status === 'done' && entry.input === null)).toBe(true);
  });

  test('updates only requested fields against the current etag', async () => {
    fx.seed('ev1', { location: 'Keep me' });
    const out = await fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Brunch' } });
    expect(out.result.event).toMatchObject({ summary: 'Brunch', etag: expect.any(String) });
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.body).toEqual({ summary: 'Brunch' });
    expect(fx.events.get('ev1')!.location).toBe('Keep me');
    const stale = await fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Again' } });
    expect(stale.error?.code).toBe('CALENDAR_EVENT_CHANGED');
    expect(patches()).toHaveLength(1);
  });

  test('provider call IDs can repeat across distinct Harness tasks', async () => {
    fx.seed('ev1');
    const input = { operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Moved' } };
    const first = await fx.tool(input, 'provider-call-0', { taskId: 101 });
    fx.seed('ev1');
    const second = await fx.tool(input, 'provider-call-0', { taskId: 102 });
    expect(first.ok && second.ok).toBe(true); expect(patches()).toHaveLength(2);
    expect((await fx.tool(input, 'provider-call-0', { taskId: 101 })).result).toEqual(first.result);
    expect(patches()).toHaveLength(2);
  });

  test('excluded events, read-only access and rejected authorization write nothing', async () => {
    fx.seed('guests', { attendees: [{ email: 'x@example.com' }] });
    fx.seed('recurring', { recurringEventId: 'parent' });
    for (const id of ['guests', 'recurring']) {
      const out = await fx.tool({ operation: 'calendar_update', event_id: id, if_etag: '"e1"', patch: { summary: 'No' } });
      expect(out.error?.code).toBe('CALENDAR_EVENT_EXCLUDED');
    }
    fx.seed('ev1');
    fx.control.role = 'reader';
    expect((await fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'No' } })).error?.code).toBe('CALENDAR_WRITE_FORBIDDEN');
    fx.control.role = 'owner';
    fx.control.onMethod = method => { if (method === 'calendarList.get') throw new GoogleCommandError('AUTH_REQUIRED'); };
    expect((await fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'No' } })).error?.code).toBe('CALENDAR_AUTH_REQUIRED');
    expect(fx.calls).toHaveLength(0);
  });

  test('only the current private conversation may write', async () => {
    fx.seed('ev1');
    const out = await fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'No' } }, undefined, { conversationId: 'other' });
    expect(out.ok).toBe(false);
    expect(fx.calls).toHaveLength(0);
    await fx.root.commit(async tx => { const bindings = await tx.doc(Bindings, fx.root.id); bindings.sources['x'] = { conversationId: fx.root.id, principal: 'emma', chatId: 2, threadId: null, cancelled: false } as never; }, context);
    expect((await fx.tool({ operation: 'calendar_create', operation_key: 'k', event: draft })).ok).toBe(false);
    expect(fx.calls).toHaveLength(0);
  });

  test('a completed call returns its recorded result on replay without another write, but only with current authority', async () => {
    fx.seed('ev1');
    const args = { operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Once' } };
    const first = await fx.tool(args, 'same-call');
    const replay = await fx.tool(args, 'same-call');
    expect(replay.result).toEqual(first.result);
    expect(patches()).toHaveLength(1);
    await fx.root.commit(async tx => { const bindings = await tx.doc(Bindings, fx.root.id); bindings.epoch = 2; bindings.epochs['2'] = 'other-conversation' as never; }, context);
    const stale = await fx.tool(args, 'same-call');
    expect(stale.ok).toBe(false);
    expect(stale.result).toBeNull();
    // A different request under a recorded call ID is never executed.
    await fx.root.commit(async tx => { const bindings = await tx.doc(Bindings, fx.root.id); bindings.epoch = 1; }, context);
    const changed = await fx.tool({ ...args, patch: { summary: 'Different' } }, 'same-call');
    expect(changed.error?.code).toBe('CALENDAR_WRITE_UNRESOLVED');
    expect(patches()).toHaveLength(1);
  });
});

describe('unknown outcomes reconcile without repeating', () => {
  const claimedUpdate = async (callId: string, input: Event) => {
    await fx.root.commit(async tx => {
      const doc = await tx.doc(CalendarNative, fx.root.id);
      doc.journal[fx.taskKey(callId)] = { id: fx.taskKey(callId), op: input.operation, fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'), epoch: '1', createdAt: Date.now(), status: 'claimed', input, confirmationId: null, body: null };
    }, context);
  };
  const update = { operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Moved' } };

  test('a lost response is verified by reading back, never patched again', async () => {
    fx.seed('ev1'); fx.control.loseResponse = true;
    const out = await fx.tool(update);
    expect(out.ok).toBe(true);
    expect(patches()).toHaveLength(1);
  });

  test('an unverifiable write reports unresolved and a retry of the same call does not write', async () => {
    fx.seed('ev1'); fx.control.loseResponse = true; fx.control.readsFail = false;
    fx.control.onMethod = method => { if (method === 'events.patch') fx.control.readsFail = true; };
    const out = await fx.tool(update, 'c1');
    expect(out.error?.code).toBe('CALENDAR_WRITE_UNRESOLVED');
    fx.control.readsFail = false;
    const replay = await fx.tool(update, 'c1');
    expect(replay.error?.code).toBe('CALENDAR_WRITE_UNRESOLVED');
    expect(patches()).toHaveLength(1);
  });

  test('interrupted before recording: applied update is found, an untouched event is reported unchanged, a diverged event is unresolved', async () => {
    fx.seed('ev1');
    await claimedUpdate('applied', update);
    fx.events.set('ev1', { ...fx.events.get('ev1'), summary: 'Moved', etag: '"e2"' });
    const applied = await fx.tool(update, 'applied');
    expect(applied.ok).toBe(true);

    fx.seed('ev1');
    await claimedUpdate('untouched', update);
    const untouched = await fx.tool(update, 'untouched');
    expect(untouched.error?.code).toBe('CALENDAR_WRITE_NOT_APPLIED');

    fx.events.set('ev1', { ...fx.events.get('ev1'), summary: 'Somebody else', etag: '"e9"' });
    await claimedUpdate('diverged', update);
    expect((await fx.tool(update, 'diverged')).error?.code).toBe('CALENDAR_WRITE_UNRESOLVED');
    expect(fx.calls).toHaveLength(0);
  });

  test('interrupted create is reconciled by its deterministic ID and is never inserted again', async () => {
    const input = { operation: 'calendar_create', operation_key: 'k9', event: draft };
    const created = await fx.tool(input, 'first');
    const id = created.result.event.id as string;
    // Forget the recorded result as if the process died before saving it.
    await fx.root.commit(async tx => { const entry = (await tx.doc(CalendarNative, fx.root.id)).journal[fx.taskKey('first')]!; entry.status = 'claimed'; entry.body = null; entry.input = input as never; }, context);
    const replay = await fx.tool(input, 'first');
    expect(replay.result.event.id).toBe(id);
    fx.events.delete(id);
    await fx.root.commit(async tx => { const entry = (await tx.doc(CalendarNative, fx.root.id)).journal[fx.taskKey('first')]!; entry.status = 'claimed'; entry.body = null; entry.input = input as never; }, context);
    expect((await fx.tool(input, 'first')).error?.code).toBe('CALENDAR_WRITE_NOT_APPLIED');
    expect(fx.calls.filter(call => call.method === 'events.insert')).toHaveLength(1);
  });

  test('an old claimed call remains read-only after retention time passes', async () => {
    fx.seed('ev1'); await claimedUpdate('old-claim', update);
    fx.control.time += 8 * 24 * 60 * 60_000;
    const result = await fx.tool(update, 'old-claim');
    expect(result.error?.code).toBe('CALENDAR_WRITE_NOT_APPLIED');
    expect(fx.calls).toHaveLength(0);
  });

  test('a completed receipt cannot be pruned into a fresh write', async () => {
    fx.seed('ev1'); const result = await fx.tool(update, 'old-done');
    fx.seed('ev1'); fx.control.time += 8 * 24 * 60 * 60_000;
    expect((await fx.tool(update, 'old-done')).result).toEqual(result.result);
    expect(patches()).toHaveLength(1);
  });

  test('authority lost after the permission read stops the write before it happens', async () => {
    fx.seed('ev1');
    fx.control.onMethod = async method => {
      if (method !== 'events.get') return;
      await fx.root.commit(async tx => { const bindings = await tx.doc(Bindings, fx.root.id); bindings.epoch = 2; bindings.epochs['2'] = 'other' as never; }, context);
    };
    const out = await fx.tool(update);
    expect(out.error?.code).toBe('CALENDAR_CANCELLED');
    expect(fx.calls).toHaveLength(0);
  });
});

describe('deletion confirmation', () => {
  test('request_delete sends direct buttons, gives the model a fixed summary without a token, and does not delete', async () => {
    fx.seed('ev1');
    const out = await requestDelete();
    expect(out).toMatchObject({ ok: true, result: { operation: 'calendar_request_delete', status: 'confirmation_required', event: { id: 'ev1', summary: 'Lunch' } } });
    expect(JSON.stringify(out)).not.toMatch(/token|gc:/);
    expect(fx.last().text).toContain('Delete event: Lunch');
    expect(fx.last().buttons.flat().map(button => button.text)).toEqual(['Confirm deletion', 'Cancel']);
    for (const button of fx.last().buttons.flat()) expect(button.callback).toMatch(/^gc:[0-9a-f]{32}$/);
    expect(deletes()).toHaveLength(0);
  });

  test('confirming deletes the exact previewed version once and is one use', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last();
    const confirm = fx.origin();
    expect(await fx.press('Confirm deletion', message, confirm)).toEqual({});
    expect(deletes()).toHaveLength(1);
    expect(fx.last().text).toBe('Event deleted.');
    expect(await rejected(fx.press('Confirm deletion', message))).toMatch(/already used/);
    expect(await rejected(fx.press('Cancel', message))).toMatch(/already used/);
    expect(await fx.press('Confirm deletion', message, confirm)).toEqual({ toast: 'Already applied' });
    expect(deletes()).toHaveLength(1);
  });

  test('cancel never deletes and consumes the confirmation', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last();
    await fx.press('Cancel', message);
    expect(fx.last().text).toMatch(/not deleted/);
    expect(await rejected(fx.press('Confirm deletion', message))).toMatch(/already used/);
    expect(deletes()).toHaveLength(0);
  });

  test('an event that changed after the preview is not deleted and a new preview is not shown', async () => {
    fx.seed('ev1'); await requestDelete();
    const shown = fx.sent.length;
    fx.events.set('ev1', { ...fx.events.get('ev1'), summary: 'Changed', etag: '"e7"' });
    await fx.press('Confirm deletion');
    expect(deletes()).toHaveLength(0);
    expect(fx.last().text).toMatch(/changed.*not deleted/i);
    expect(fx.sent).toHaveLength(shown + 1);
  });

  test('excluded events and stale etags never produce a confirmation', async () => {
    fx.seed('g', { attendees: [{ email: 'x@example.com' }] });
    expect((await requestDelete('g')).error?.code).toBe('CALENDAR_EVENT_EXCLUDED');
    fx.seed('ev1');
    expect((await requestDelete('ev1', '"old"')).error?.code).toBe('CALENDAR_EVENT_CHANGED');
    expect(fx.sent).toHaveLength(0);
    expect(Object.keys((await fx.state()).confirmations)).toHaveLength(0);
  });

  test('a pending confirmation survives a restart', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last();
    await fx.reopen();
    await fx.press('Confirm deletion', message);
    expect(deletes()).toHaveLength(1);
  });

  test('wrong actor, chat, message, epoch, expiry and unknown keys are refused without effect', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last();
    await rejected(fx.press('Confirm deletion', message, { actorId: 9 }));
    await rejected(fx.press('Confirm deletion', message, { target: { chatId: 9 } }));
    await rejected(fx.press('Confirm deletion', message, { principal: 'emma' }));
    await rejected(fx.press('Confirm deletion', message, { messageId: message.messageId + 1 }));
    await rejected(fx.calendar.callback({ ...fx.origin(), messageId: message.messageId, key: 'f'.repeat(32) }));
    await rejected(fx.calendar.callback({ ...fx.origin(), messageId: message.messageId, key: 'nothex' }));
    expect(deletes()).toHaveLength(0);
    await fx.root.commit(async tx => { const bindings = await tx.doc(Bindings, fx.root.id); bindings.epoch = 2; bindings.epochs['2'] = 'other' as never; }, context);
    await rejected(fx.press('Confirm deletion', message));
    await fx.root.commit(async tx => { (await tx.doc(Bindings, fx.root.id)).epoch = 1; }, context);
    fx.control.time += CALENDAR_TTL_MS + 1;
    await rejected(fx.press('Confirm deletion', message));
    expect(deletes()).toHaveLength(0);
  });

  test('a confirmation that lapses between the claim and the write is not executed', async () => {
    fx.seed('ev1'); await requestDelete();
    fx.control.onMethod = method => { if (method === 'events.get') fx.control.time += CALENDAR_TTL_MS + 1; };
    await fx.press('Confirm deletion');
    expect(deletes()).toHaveLength(0);
    expect(fx.last().text).toMatch(/not deleted/);
  });

  test('reset and reload invalidate pending confirmations', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last();
    await fx.calendar.invalidate();
    await rejected(fx.press('Confirm deletion', message));
    expect(deletes()).toHaveLength(0);
  });

  test('reload between claiming and starting transport revokes the claimed confirmation', async () => {
    fx.seed('ev1'); await requestDelete(); const preview = fx.last();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const commit = fx.root.commit.bind(fx.root); let count = 0;
    (fx.host.runtime as any).root = { id: fx.root.id, commit: async (fn: any, ctx: any) => {
      const result = await commit(fn, ctx);
      if (++count === 2) { entered.resolve(); await release.promise; }
      return result;
    } };
    const callback = fx.press('Confirm deletion', preview);
    try { await entered.promise; await fx.calendar.invalidate(); } finally { release.resolve(); }
    await callback;
    expect(deletes()).toHaveLength(0);
  });

  test('unknown presentation cannot authorize and is reported to the model as not shown', async () => {
    fx.seed('ev1'); fx.control.receipt = false;
    const out = await requestDelete();
    expect(out.error?.code).toBe('CALENDAR_CONFIRMATION_UNAVAILABLE');
    const message = fx.last();
    await rejected(fx.press('Confirm deletion', { ...message, messageId: 101 }));
    expect(deletes()).toHaveLength(0);

    fx.control.receipt = true; fx.control.failPresent = true;
    expect((await requestDelete()).error?.code).toBe('CALENDAR_CONFIRMATION_UNAVAILABLE');
    expect(Object.values((await fx.state()).confirmations).every(item => item.state === 'expired')).toBe(true);
  });

  test('a replayed request_delete never presents a second message', async () => {
    fx.seed('ev1');
    await requestDelete();
    const count = fx.sent.length;
    const replay = await fx.tool({ operation: 'calendar_request_delete', event_id: 'ev1', if_etag: '"e1"' }, 'call-1');
    expect(replay.result.status).toBe('confirmation_required');
    expect(fx.sent).toHaveLength(count);
    // Interrupted after the preview was prepared but before delivery was recorded.
    await fx.root.commit(async tx => {
      const doc = await tx.doc(CalendarNative, fx.root.id);
      const entry = doc.journal[fx.taskKey('call-1')]!; entry.status = 'claimed'; entry.body = null;
      for (const item of Object.values(doc.confirmations)) item.messageId = null;
    }, context);
    const unknown = await fx.tool({ operation: 'calendar_request_delete', event_id: 'ev1', if_etag: '"e1"' }, 'call-1');
    expect(unknown.error?.code).toBe('CALENDAR_CONFIRMATION_UNAVAILABLE');
    expect(fx.sent).toHaveLength(count);
  });

  test('a claimed deletion with no recorded result reconciles read-only after restart and never deletes again', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last();
    const request = fx.origin();
    const id = Object.keys((await fx.state()).confirmations)[0]!;
    // Process died after claiming and after Google removed the event, before saving the outcome.
    await fx.root.commit(async tx => { const item = (await tx.doc(CalendarNative, fx.root.id)).confirmations[id]!; item.state = 'claimed'; item.commandId = request.commandId; }, context);
    fx.events.set('ev1', { id: 'ev1', status: 'cancelled' });
    await fx.reopen();
    await fx.press('Confirm deletion', message, request);
    expect(deletes()).toHaveLength(0);
    expect(fx.last().text).toBe('Event deleted.');
  });

  test('a claimed deletion that did not land is reported not deleted, and a diverged event is unresolved', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last();
    const request = fx.origin();
    const id = Object.keys((await fx.state()).confirmations)[0]!;
    await fx.root.commit(async tx => { const item = (await tx.doc(CalendarNative, fx.root.id)).confirmations[id]!; item.state = 'claimed'; item.commandId = request.commandId; }, context);
    await fx.press('Confirm deletion', message, request);
    expect(fx.last().text).toMatch(/was not deleted/);
    expect(deletes()).toHaveLength(0);

    fx.seed('ev2'); fx.sent.length = 0; await requestDelete('ev2');
    const second = fx.last(); const again = fx.origin();
    const id2 = Object.keys((await fx.state()).confirmations).find(key => key !== id)!;
    await fx.root.commit(async tx => { const item = (await tx.doc(CalendarNative, fx.root.id)).confirmations[id2]!; item.state = 'claimed'; item.commandId = again.commandId; }, context);
    fx.events.set('ev2', { ...fx.events.get('ev2'), etag: '"e50"' });
    await fx.press('Confirm deletion', second, again);
    expect(fx.last().text).toMatch(/could not be verified/);
    expect(deletes()).toHaveLength(0);
  });

  test('a lost delete response is verified by a tombstone and never retried', async () => {
    fx.seed('ev1'); await requestDelete(); fx.control.loseResponse = true;
    await fx.press('Confirm deletion');
    expect(deletes()).toHaveLength(1);
    expect(fx.last().text).toBe('Event deleted.');
  });

  test('an unverifiable delete is reported unresolved without a second attempt', async () => {
    fx.seed('ev1'); await requestDelete(); fx.control.loseResponse = true;
    fx.control.onMethod = method => { if (method === 'events.delete') fx.control.readsFail = true; };
    await fx.press('Confirm deletion');
    expect(fx.last().text).toMatch(/could not be verified/);
    expect(deletes()).toHaveLength(1);
  });

  test('a failed result message never repeats the deletion', async () => {
    fx.seed('ev1'); await requestDelete();
    const message = fx.last(); const request = fx.origin();
    fx.control.failPresent = true;
    expect(await fx.press('Confirm deletion', message, request)).toMatchObject({ toast: expect.stringMatching(/Could not send/) });
    expect(deletes()).toHaveLength(1);
    fx.control.failPresent = false;
    await fx.press('Confirm deletion', message, request);
    expect(fx.last().text).toBe('Event deleted.');
    expect(deletes()).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  test('close after an update effect preserves a claim for read-only recovery', async () => {
    fx.seed('ev1'); const entered = Promise.withResolvers<void>();
    fx.control.onMethod = async (method, signal) => {
      if (method !== 'events.get' || patches().length === 0) return;
      entered.resolve();
      await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    };
    const input = { operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Applied before close' } };
    const pending = fx.tool(input, 'closing-update'); await entered.promise;
    await fx.calendar.close(); expect((await pending).ok).toBe(false);
    expect((await fx.state()).journal[fx.taskKey('closing-update')].status).toBe('claimed');
    fx.control.onMethod = undefined; await fx.reopen();
    expect((await fx.tool(input, 'closing-update')).result.event.summary).toBe('Applied before close');
    expect(patches()).toHaveLength(1);
  }, 3000);

  test('close after a delete effect preserves the original callback for read-only recovery', async () => {
    fx.seed('ev1'); await requestDelete(); const preview = fx.last(), origin = fx.origin();
    const entered = Promise.withResolvers<void>(); fx.control.loseResponse = true;
    fx.control.onMethod = async (method, signal) => {
      if (method !== 'events.get' || deletes().length === 0) return;
      entered.resolve();
      await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    };
    const pending = fx.press('Confirm deletion', preview, origin); await entered.promise;
    await fx.calendar.close(); await pending;
    expect(Object.values((await fx.state()).confirmations)[0]).toMatchObject({ state: 'claimed', outcome: null });
    fx.control.onMethod = undefined; fx.control.loseResponse = false; await fx.reopen();
    await fx.press('Confirm deletion', preview, origin);
    expect(fx.last().text).toBe('Event deleted.'); expect(deletes()).toHaveLength(1);
  }, 3000);

  test('close aborts a blocked transport and drains it before returning', async () => {
    fx.seed('ev1'); const entered = Promise.withResolvers<void>();
    fx.control.onMethod = async (method, signal) => {
      if (method !== 'calendarList.get') return;
      entered.resolve();
      await new Promise((_, reject) => {
        signal!.throwIfAborted();
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
    };
    const pending = fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Slow' } });
    await entered.promise;
    await fx.calendar.close(); await pending;
    expect(fx.calls).toHaveLength(0);
  }, 3000);

  test('close waits for in-flight work and then refuses new work', async () => {
    fx.seed('ev1');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fx.control.onMethod = async method => { if (method === 'calendarList.get') await gate; };
    const pending = fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e1"', patch: { summary: 'Slow' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    let closed = false;
    const closing = fx.calendar.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    release();
    await closing;
    await pending;
    expect(closed).toBe(true);
    await expect(fx.calendar.callback({ ...fx.origin(), messageId: 1, key: 'a'.repeat(32) })).rejects.toThrow(/closed/);
    const late = await fx.tool({ operation: 'calendar_update', event_id: 'ev1', if_etag: '"e2"', patch: { summary: 'Late' } });
    expect(late.ok).toBe(false);
    await fx.calendar.close();
  });
});
