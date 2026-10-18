import { expect, test } from 'vitest';
import { executeGoogleRead } from '../../.pi/lib/google-workspace-reads.js';

function harness(payload: unknown = {}) {
  const calls: string[][] = [];
  return { calls, options: { async run(_r: unknown, args: string[]) { calls.push(args); return payload; } } };
}

test('unsupported and mutating operations are rejected before any transport call', async () => {
  const h = harness();
  for (const operation of ['calendar_create', 'calendar_update', 'calendar_request_delete', 'bogus', 7]) {
    expect(await executeGoogleRead({ operation }, { account: 'a@example.com' }, h.options)).toEqual({
      ok: false, code: 'GOOGLE_OPERATION_INVALID', message: 'The Google Workspace operation is invalid',
    });
  }
  expect(h.calls).toEqual([]);
});

test('account is required for Workspace reads and validated inputs fail without transport', async () => {
  const h = harness();
  expect(await executeGoogleRead({ operation: 'gmail_search', query: 'x' }, {}, h.options)).toMatchObject({ ok: false, code: 'GOOGLE_ACCOUNT_REQUIRED' });
  expect(await executeGoogleRead({ operation: 'gmail_search', query: '--evil' }, { account: 'a@example.com' }, h.options)).toMatchObject({ ok: false, code: 'GOOGLE_GMAIL_INPUT_INVALID' });
  expect(await executeGoogleRead({ operation: 'calendar_events', from: 'x', to: 'y' }, { account: 'a@example.com' }, h.options)).toMatchObject({ ok: false, code: 'GOOGLE_CALENDAR_WINDOW_INVALID' });
  expect(h.calls).toEqual([]);
});

test('transport failures map to fixed unavailable messages without leaking details', async () => {
  const options = { async run(): Promise<unknown> { throw new Error('secret-stderr'); } };
  const out = await executeGoogleRead({ operation: 'gmail_thread', thread_id: 't1' }, { account: 'a@example.com' }, options);
  expect(out).toEqual({ ok: false, code: 'GOOGLE_GMAIL_UNAVAILABLE', message: 'Gmail is temporarily unavailable for account a@example.com' });
});

test('calendar_list uses readonly-safe common args', async () => {
  const h = harness({ calendars: [] });
  await executeGoogleRead({ operation: 'calendar_list' }, { account: 'a@example.com' }, h.options);
  expect(h.calls[0]).toContain('calendars');
  expect(h.calls[0]).toContain('--max=50');
});

test('calendar_event is a guarded read and requires configured calendar targets', async () => {
  const h = harness();
  expect(await executeGoogleRead({ operation: 'calendar_event', event_id: 'abc123' }, { account: 'a@example.com' }, h.options))
    .toMatchObject({ ok: false, code: 'CALENDAR_READ_NOT_CONFIGURED' });
  expect(h.calls).toEqual([]);
});

test('places input errors flow through the existing gateway', async () => {
  const h = harness();
  const out = await executeGoogleRead({ operation: 'places_search', field_profile: 'bogus', query: 'x' }, {}, h.options);
  expect(out).toMatchObject({ ok: false, code: 'GOOGLE_PLACES_INPUT_INVALID' });
});

test('account aliases resolve through bounded metadata reads without exposing tokens',async()=>{
 const calls:string[][]=[];
 const out=await executeGoogleRead({operation:'account_status'},{account:'personal'},{run:async(_runtime,args)=>{calls.push(args);return args.includes('alias')?{aliases:{personal:'a@example.com'}}:{accounts:[{email:'a@example.com',services:['gmail','calendar'],scopes:[],token:'secret'}]};}});
 expect(out).toMatchObject({ok:true,result:{account:'personal',authenticated:true,services:['calendar','gmail'],calendarWriteScopeGranted:false}});expect(JSON.stringify(out)).not.toContain('secret');expect(calls).toHaveLength(2);
});

test('availability deduplicates accounts and normalizes overlapping busy periods',async()=>{
 const calls:string[][]=[];
 const out=await executeGoogleRead({operation:'calendar_availability',accounts:['a@example.com','b@example.com','a@example.com'],from:'2026-06-01',to:'2026-06-02'}, {}, {run:async(_runtime,args)=>{calls.push(args);return {calendars:{primary:{busy:[{start:'2026-06-01T10:00:00Z',end:'2026-06-01T11:00:00Z'}]}}};}});
 expect(out).toMatchObject({ok:true,result:{accounts:[{account:'a@example.com'},{account:'b@example.com'}],conflicts:[{start:'2026-06-01T10:00:00.000Z',end:'2026-06-01T11:00:00.000Z'}],truncated:false}});
 expect(calls).toHaveLength(2);for(const args of calls)expect(args).toEqual(expect.arrayContaining(['--readonly','--gmail-no-send','--no-input','freebusy','--cal=primary']));
});
