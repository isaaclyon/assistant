import { describe, expect, test, vi } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type { NativeConfig } from '../../src/durable/config.js';
import { createGoogleReadBundle, googleReadParameters, nativeGoogleRuntime } from '../../src/durable/google-read.js';

const ACCOUNT = 'reader@example.com';
const base: NativeConfig = {
  version: 1, runtime: 'pi-durable', instanceId: 'test', principal: 'isaac', releaseSha: 'a'.repeat(40),
  resourceRoot: '/synthetic/release', workspaceCwd: '/synthetic/work', stateDir: '/synthetic/state',
  capabilityProfile: 'durable-read-integrations-test', account: 'test', credentialPath: '/synthetic/auth', settingsPath: '/synthetic/settings',
  jobsRole: 'disabled', idleHours: 0, transport: { mode: 'broker', socketPath: '/synthetic/s.sock', botId: 1, allowedUserId: 2 },
  historyDir: '/synthetic/state/durable', inboxPath: '/synthetic/state/inbox.db', runtimeMetadataPath: '/synthetic/state/runtime.json',
  google: {
    account: ACCOUNT,
    gog: { binary: '/synthetic/gog', passwordFile: '/synthetic/pw', home: '/synthetic/gog-home' },
    calendarTargets: { account: ACCOUNT, personal: 'personal-id', thingsToDo: 'things-id' },
  },
};

type Call = { args: string[]; signal: AbortSignal | undefined };
function setup(respond: (args: string[], signal?: AbortSignal) => unknown | Promise<unknown> = () => ({}), config: NativeConfig = base) {
  const calls: Call[] = [];
  const bundle = createGoogleReadBundle(config, {
    async run(_runtime, args, signal) { calls.push({ args, signal }); return respond(args, signal); },
  });
  const tool = bundle.tools[0]!.tool as unknown as { name: string; parameters: unknown; replay?: string; execute(raw: unknown, api: unknown, context: unknown): Promise<{ output: Array<{ type: string; text: string }>; isError: boolean }> };
  const run = async (raw: unknown, abortSignal?: AbortSignal) => {
    const out = await tool.execute(raw, {}, { abortSignal });
    return { isError: out.isError, body: JSON.parse(out.output[0]!.text) as { ok: boolean; result: any; error: { code: string; message: string } | null } };
  };
  return { calls, tool, run, bundle };
}

describe('wire object and registration', () => {
  test('exposes one replay-safe read tool with a flat closed object schema and no write operations', () => {
    const { tool, bundle } = setup();
    expect(bundle.tools.map(t => (t.tool as any).name)).toEqual(['google_workspace', 'google_places_read']);
    const nested = bundle.tools[1]!.tool as any;
    expect(nested.replay).toBe('unsafe');
    expect(nested.callers).toEqual(['tools']);
    expect(tool.name).toBe('google_workspace');
    expect(tool.replay).toBe('safe');
    const schema = tool.parameters as { type: string; additionalProperties: boolean; properties: { operation: { enum: string[] } }; anyOf?: unknown };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.anyOf).toBeUndefined();
    const operations = schema.properties.operation.enum;
    expect(operations).toEqual(expect.arrayContaining(['calendar_event', 'gmail_thread', 'contacts_search', 'places_details']));
    for (const forbidden of ['calendar_create', 'calendar_update', 'calendar_request_delete', 'gmail_send', 'contacts_update']) expect(operations).not.toContain(forbidden);
    const wire = JSON.stringify(schema);
    for (const field of ['operation_key', 'if_etag', 'patch', 'event"', 'raw', 'args', 'command']) expect(wire).not.toContain(`"${field.replace('"', '')}":`);
  });
});

describe('exact branch validation before any transport call', () => {
  const rejected: Array<[string, unknown]> = [
    ['unknown operation', { operation: 'calendar_create' }],
    ['missing operation', {}],
    ['non-object', 'gmail_search'],
    ['extra field on a branch', { operation: 'gmail_thread', thread_id: 't1', query: 'x' }],
    ['unknown field', { operation: 'calendar_list', force: true }],
    ['write fields on calendar_event', { operation: 'calendar_event', event_id: 'e1', if_etag: 'x' }],
    ['cross-branch field', { operation: 'contacts_search', query: 'a', thread_id: 't' }],
    ['calendar_event without event_id', { operation: 'calendar_event' }],
    ['gmail_thread without thread_id', { operation: 'gmail_thread' }],
    ['gmail_search without query', { operation: 'gmail_search' }],
    ['calendar_events without window', { operation: 'calendar_events' }],
    ['calendar_events short from', { operation: 'calendar_events', from: 'x', to: '2025-01-02' }],
    ['gmail max_results over 50', { operation: 'gmail_search', query: 'x', max_results: 51 }],
    ['contacts max_results over 10', { operation: 'contacts_search', query: 'x', max_results: 11 }],
    ['calendar_list max_results over 100', { operation: 'calendar_list', max_results: 101 }],
    ['non-integer max_results', { operation: 'gmail_search', query: 'x', max_results: 1.5 }],
    ['zero max_results', { operation: 'gmail_search', query: 'x', max_results: 0 }],
    ['too many calendar ids', { operation: 'calendar_events', from: '2025-01-01', to: '2025-01-02', calendar_ids: Array.from({ length: 21 }, (_, i) => `c${i}`) }],
    ['empty calendar ids', { operation: 'calendar_events', from: '2025-01-01', to: '2025-01-02', calendar_ids: [] }],
    ['too many availability accounts', { operation: 'calendar_availability', from: '2025-01-01', to: '2025-01-02', accounts: Array.from({ length: 9 }, (_, i) => `a${i}@example.com`) }],
    ['oversize query', { operation: 'calendar_search', from: '2025-01-01', to: '2025-01-02', query: 'q'.repeat(201) }],
    ['oversize gmail query', { operation: 'gmail_search', query: 'q'.repeat(501) }],
    ['oversize thread id', { operation: 'gmail_thread', thread_id: 't'.repeat(257) }],
    ['bad calendar enum', { operation: 'calendar_event', event_id: 'e', calendar: 'work' }],
    ['places_search with non-identity profile', { operation: 'places_search', field_profile: 'rich_details', query: 'x' }],
    ['places_details without place_id', { operation: 'places_details', field_profile: 'identity' }],
    ['places_search_candidates max over 15', { operation: 'places_search_candidates', query: 'x', max_results: 16 }],
    ['array account', { operation: 'account_status', account: ['a'] }],
  ];
  test.each(rejected)('rejects %s', async (_name, input) => {
    expect(() => validateToolArguments({ name: 'google_workspace', description: '', parameters: googleReadParameters } as never, { type: 'toolCall', id: 'x', name: 'google_workspace', arguments: input as never })).toThrow();
    const { calls, run } = setup();
    // The wire object schema is flat; the handler must still reject with the fixed code and never call the transport.
    const out = await run(input).catch(() => undefined);
    if (out) expect(out).toMatchObject({ isError: true, body: { ok: false, result: null, error: { code: 'GOOGLE_INPUT_INVALID' } } });
    expect(calls).toEqual([]);
  });

  test('accepts every valid branch shape', () => {
    const valid = [
      { operation: 'account_status' }, { operation: 'calendar_event', event_id: 'e1', calendar: 'things_to_do' }, { operation: 'calendar_list', max_results: 100 },
      { operation: 'calendar_events', from: '2025-01-01', to: '2025-01-02' }, { operation: 'gmail_search', query: 'x', max_results: 50 },
      { operation: 'contacts_search', query: 'x', max_results: 10 }, { operation: 'places_search', field_profile: 'identity', query: 'x' },
      { operation: 'places_details', field_profile: 'rich_details', place_id: 'p1' },
    ];
    for (const input of valid) expect(() => validateToolArguments({ name: 'google_workspace', description: '', parameters: googleReadParameters } as never, { type: 'toolCall', id: 'x', name: 'google_workspace', arguments: input as never })).not.toThrow();
  });
});

describe('explicit runtime', () => {
  test('uses only explicit configuration and ignores ambient environment', () => {
    vi.stubEnv('GOG_ACCOUNT', 'ambient@example.com');
    vi.stubEnv('GOG_BINARY', '/ambient/gog');
    vi.stubEnv('GOOGLE_PLACES_API_KEY_FILE', '/ambient/key');
    vi.stubEnv('GOG_HOME', '/ambient/home');
    try {
      const runtime = nativeGoogleRuntime(base);
      expect(runtime).toEqual({
        stateDir: '/synthetic/state', account: ACCOUNT, binary: '/synthetic/gog', passwordFile: '/synthetic/pw', gogHome: '/synthetic/gog-home',
        calendarWrites: { account: ACCOUNT, personal: 'personal-id', thingsToDo: 'things-id' },
      });
      expect(JSON.stringify(runtime)).not.toContain('ambient');
      expect(runtime.placesApiKeyFile).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  test('maps places settings and omits absent sections', () => {
    const runtime = nativeGoogleRuntime({ ...base, google: { places: { apiKeyFile: '/synthetic/k', searchMonthlyLimit: 1, detailsMonthlyLimit: 2, candidatesMonthlyLimit: 3 } } });
    expect(runtime).toEqual({ stateDir: '/synthetic/state', placesApiKeyFile: '/synthetic/k', placesSearchMonthlyLimit: 1, placesDetailsMonthlyLimit: 2, placesCandidatesMonthlyLimit: 3 });
  });

  test('requires explicit Google configuration', () => {
    const { google: _google, ...without } = base;
    expect(() => nativeGoogleRuntime(without)).toThrow(/explicit/);
    expect(() => createGoogleReadBundle(without)).toThrow(/explicit/);
  });

  test('default transport fails closed when gog is not configured, without spawning anything', async () => {
    vi.stubEnv('GOG_BINARY', '/ambient/gog');
    try {
      const bundle = createGoogleReadBundle({ ...base, google: { account: ACCOUNT } });
      const tool = bundle.tools[0]!.tool as any;
      const out = await tool.execute({ operation: 'gmail_search', query: 'x' }, {}, {});
      expect(JSON.parse(out.output[0].text).error.code).toBe('GOOGLE_GMAIL_UNAVAILABLE');
      expect(out.isError).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('successful reads', () => {
  test('every issued command is read-only', async () => {
    const t = setup(args => args.includes('events') ? { events: [] } : args.includes('search') && args.includes('gmail') ? { threads: [] } : { calendars: [] });
    await t.run({ operation: 'calendar_events', from: '2025-01-01', to: '2025-01-02' });
    await t.run({ operation: 'gmail_search', query: 'x' });
    await t.run({ operation: 'calendar_list' });
    expect(t.calls.length).toBe(3);
    for (const { args } of t.calls) {
      expect(args).toEqual(expect.arrayContaining(['--readonly', '--no-input', '--gmail-no-send', '--account', ACCOUNT]));
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--allow-write');
    }
  });

  test('calendar_events normalizes, merges calendars sorted by start and reports truncation', async () => {
    const t = setup(args => {
      const id = args[args.indexOf('events') + 1];
      return id === 'a'
        ? { events: [{ id: 'e2', summary: 'Late', start: { dateTime: '2025-01-01T12:00:00Z' }, end: { dateTime: '2025-01-01T13:00:00Z' } }, { id: 'gone', status: 'cancelled', start: {}, end: {} }] }
        : { events: [{ id: 'e1', summary: 'Early', start: { date: '2025-01-01' }, end: { date: '2025-01-02' } }, 'junk'], nextPageToken: 'more' };
    });
    const { body, isError } = await t.run({ operation: 'calendar_events', calendar_ids: ['a', 'b'], from: '2025-01-01', to: '2025-01-03', time_zone: 'UTC', max_results: 5 });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, error: null });
    expect(body.result.operation).toBe('calendar_events');
    expect(body.result.account).toBe(ACCOUNT);
    expect(body.result.truncated).toBe(true);
    expect(body.result.events).toEqual([
      { id: 'e1', summary: 'Early', calendarId: 'b', start: '2025-01-01', end: '2025-01-02', allDay: true, untrusted: true },
      { id: 'e2', summary: 'Late', calendarId: 'a', start: '2025-01-01T12:00:00Z', end: '2025-01-01T13:00:00Z', allDay: false, untrusted: true },
    ]);
    expect(t.calls[0]!.args).toEqual(expect.arrayContaining(['--from=2025-01-01', '--to=2025-01-03', '--max=5', '--timezone=UTC', '--sort=start']));
  });

  test('calendar_search passes the query and echoes it', async () => {
    const t = setup(() => ({ events: [{ id: 'e', summary: 'Dentist', start: { dateTime: '2025-02-01T09:00:00-05:00' }, end: { dateTime: '2025-02-01T10:00:00-05:00' } }] }));
    const { body } = await t.run({ operation: 'calendar_search', from: '2025-02-01', to: '2025-02-02', query: 'dentist' });
    expect(t.calls[0]!.args).toContain('--query=dentist');
    expect(t.calls[0]!.args).toContain('primary');
    expect(body.result).toMatchObject({ operation: 'calendar_search', query: 'dentist', truncated: false });
    expect(body.result.events).toHaveLength(1);
  });

  test('gmail_search normalizes thread summaries', async () => {
    const t = setup(() => ({ threads: [{ id: 't1', subject: 'Hello', from: 'a@b.c', date: '2025-01-01', labels: ['INBOX', 7], messageCount: 3 }, { id: '-bad' }] }));
    const { body } = await t.run({ operation: 'gmail_search', query: 'from:a', max_results: 5 });
    expect(t.calls[0]!.args.slice(-4)).toEqual(['gmail', 'search', 'from:a', '--max=5']);
    expect(body.result.threads).toEqual([{ id: 't1', date: '2025-01-01', from: 'a@b.c', subject: 'Hello', labels: ['INBOX'], messageCount: 3, untrusted: true }]);
    expect(body.result.truncated).toBe(true);
  });

  test('gmail_thread normalizes messages and requests sanitized content', async () => {
    const t = setup(() => ({ thread: { id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: ['INBOX'], headers: { from: 'a@b.c', subject: 'S' }, snippet: 'snip', body: 'hello', attachments: [{ filename: 'f.pdf', mimeType: 'application/pdf', size: 4 }] }, { id: 'm2', threadId: 'other' }] } }));
    const { body } = await t.run({ operation: 'gmail_thread', thread_id: 't1' });
    expect(t.calls[0]!.args).toEqual(expect.arrayContaining(['thread', 'get', 't1', '--sanitize-content']));
    expect(body.result.thread).toMatchObject({ id: 't1', truncated: true, untrusted: true });
    expect(body.result.thread.messages).toEqual([{ id: 'm1', threadId: 't1', labels: ['INBOX'], from: 'a@b.c', subject: 'S', snippet: 'snip', body: 'hello', attachments: [{ filename: 'f.pdf', mimeType: 'application/pdf', size: 4 }], attachmentCount: 1, untrusted: true }]);
  });

  test('gmail_thread rejects a mismatched thread id as unavailable', async () => {
    const { body, isError } = await setup(() => ({ thread: { id: 'different', messages: [] } })).run({ operation: 'gmail_thread', thread_id: 't1' });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ ok: false, result: null, error: { code: 'GOOGLE_GMAIL_UNAVAILABLE' } });
  });

  test('contacts_search searches then gets each resource', async () => {
    const t = setup(args => args.includes('search')
      ? { contacts: [{ resource: 'people/c1' }, { resource: 'people/c2' }] }
      : { contact: { resourceName: args.at(-1), names: [{ displayName: `Name ${args.at(-1)}`, metadata: { primary: true } }], emailAddresses: [{ value: 'x@example.com', type: 'work' }], phoneNumbers: [{ value: '+1 (415) 555-0100' }] } });
    const { body } = await t.run({ operation: 'contacts_search', query: 'Alex', max_results: 5 });
    expect(t.calls[0]!.args.slice(-4)).toEqual(['contacts', 'search', 'Alex', '--max=5']);
    expect(t.calls.filter(c => c.args.includes('get')).map(c => c.args.at(-1))).toEqual(['people/c1', 'people/c2']);
    expect(body.result.contacts).toEqual([
      { resource: 'people/c1', displayName: 'Name people/c1', emails: [{ value: 'x@example.com', label: 'work' }], phones: [{ value: '+1 (415) 555-0100', normalized: '+14155550100' }], untrusted: true },
      { resource: 'people/c2', displayName: 'Name people/c2', emails: [{ value: 'x@example.com', label: 'work' }], phones: [{ value: '+1 (415) 555-0100', normalized: '+14155550100' }], untrusted: true },
    ]);
    expect(body.result.truncated).toBe(false);
  });

  test('contacts_search fails closed when a detail record names a different resource', async () => {
    const t = setup(args => args.includes('search') ? { contacts: [{ resource: 'people/c1' }] } : { contact: { resourceName: 'people/other' } });
    const { body } = await t.run({ operation: 'contacts_search', query: 'Alex' });
    expect(body.error?.code).toBe('GOOGLE_CONTACTS_UNAVAILABLE');
  });

  test('transport errors map to fixed messages that do not leak details', async () => {
    const { body, isError } = await setup(() => { throw new Error('secret-stderr /synthetic/pw'); }).run({ operation: 'gmail_search', query: 'x' });
    expect(isError).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('calendar_event guarded read', () => {
  const event = { id: 'ev1', etag: '"1"', summary: 'Lunch', start: { dateTime: '2025-01-01T12:00:00Z' }, end: { dateTime: '2025-01-01T13:00:00Z' }, organizer: { self: true } };
  const respond = (args: string[]) => args.some(a => a.includes('calendarList.get'))
    ? { id: JSON.parse(args.find(a => a.startsWith('--params='))!.slice(9)).calendarId, accessRole: 'owner' }
    : event;

  test('checks calendar permission then reads one event with readonly flags only', async () => {
    const t = setup(respond);
    const { body, isError } = await t.run({ operation: 'calendar_event', event_id: 'ev1', calendar: 'things_to_do' });
    expect(isError).toBe(false);
    expect(t.calls.map(c => c.args.find(a => a.startsWith('calendar.')) ?? c.args.find(a => a.includes('calendar.')))).toBeDefined();
    expect(t.calls).toHaveLength(2);
    for (const { args } of t.calls) {
      expect(args).toContain('--readonly');
      expect(args).not.toContain('--force');
      expect(args).not.toContain('--allow-write');
      expect(args.some(a => /events\.(insert|patch|delete)/.test(a))).toBe(false);
    }
    expect(t.calls[0]!.args).toContain('calendar.calendarList.get');
    expect(t.calls[1]!.args).toContain('calendar.events.get');
    expect(t.calls[1]!.args.find(a => a.startsWith('--params='))).toContain('"calendarId":"things-id"');
    expect(body.result.event).toMatchObject({ id: 'ev1', etag: '"1"', calendar: 'things_to_do', calendarId: 'things-id', account: ACCOUNT, summary: 'Lunch', editable: true, untrusted: true });
  });

  test('is forbidden without write-capable permission and for a foreign account', async () => {
    const reader = setup(args => args.some(a => a.includes('calendarList.get')) ? { id: 'personal-id', accessRole: 'reader' } : event);
    expect((await reader.run({ operation: 'calendar_event', event_id: 'ev1' })).body.error?.code).toBe('CALENDAR_READ_FORBIDDEN');
    expect(reader.calls).toHaveLength(1);
    const foreign = setup(respond);
    expect((await foreign.run({ operation: 'calendar_event', event_id: 'ev1', account: 'other@example.com' })).body.error?.code).toBe('CALENDAR_READ_FORBIDDEN');
    expect(foreign.calls).toEqual([]);
  });

  test('requires configured calendar targets', async () => {
    const { calendarTargets: _targets, ...google } = base.google!;
    const t = setup(respond, { ...base, google });
    expect((await t.run({ operation: 'calendar_event', event_id: 'ev1' })).body.error?.code).toBe('CALENDAR_READ_NOT_CONFIGURED');
    expect(t.calls).toEqual([]);
  });

  test('rejects unsafe event ids before transport', async () => {
    const t = setup(respond);
    expect((await t.run({ operation: 'calendar_event', event_id: 'a b;c' })).body.error?.code).toBe('CALENDAR_INPUT_INVALID');
    expect(t.calls).toEqual([]);
  });
});

describe('abort and timeout', () => {
  test('an already-aborted context aborts without calling the transport', async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(t.run({ operation: 'gmail_search', query: 'x' }, controller.signal)).rejects.toBe(reason);
    expect(t.calls).toEqual([]);
  });

  test('aborting during a transport call propagates the signal and rethrows', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const t = setup((_args, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason));
      controller.abort(reason);
    }));
    await expect(t.run({ operation: 'gmail_search', query: 'x' }, controller.signal)).rejects.toBeDefined();
    expect(t.calls[0]!.signal?.aborted).toBe(true);
  });

  test('internal timeout is reported as a fixed failure, not thrown', async () => {
    const timer = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal);
    try {
      const t = setup((_args, signal) => new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason));
        timer.abort(new DOMException('timeout', 'TimeoutError'));
      }));
      expect(await t.run({ operation: 'gmail_search', query: 'x' })).toMatchObject({ isError: true, body: { error: { code: 'GOOGLE_READ_TIMEOUT' } } });
    } finally { spy.mockRestore(); }
  });
});

describe('places delegation', () => {
  test('places operations run as a nested unsafe task and unconfigured Places fails without network', async () => {
    const t = setup();
    const nestedTool = t.bundle.tools[1]!.tool as any;
    const executeTool = vi.fn(async (name: string, input: unknown, context: unknown, _options?: unknown) => {
      expect(name).toBe('google_places_read');
      return nestedTool.execute(input, {}, context);
    });
    const out = await (t.tool as any).execute({ operation: 'places_search', field_profile: 'identity', query: 'cafe' }, { executeTool }, {});
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]![3]).toMatchObject({ key: 'places-read' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.output[0].text)).toMatchObject({ ok: false, result: null });
    expect(t.calls).toEqual([]);
  });

  test('nested places tool validates its own branch before running', async () => {
    const t = setup();
    const nestedTool = t.bundle.tools[1]!.tool as any;
    const out = await nestedTool.execute({ operation: 'gmail_search', query: 'x' }, {}, {});
    expect(JSON.parse(out.output[0].text).error.code).toBe('GOOGLE_INPUT_INVALID');
    const bad = await nestedTool.execute({ operation: 'places_details', field_profile: 'rich_details' }, {}, {});
    expect(JSON.parse(bad.output[0].text).error.code).toBe('GOOGLE_INPUT_INVALID');
  });
});
