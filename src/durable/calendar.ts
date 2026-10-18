import { createHash, randomUUID } from 'node:crypto';
import { defineDoc, type ConversationId, type ToolExecutionApi, type Tx } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { CalendarWriteError, CalendarWrites, type PreparedDelete, type Reconciliation } from '../../.pi/lib/google-calendar-writes.js';
import { hasGogRuntime, runGogJson, type GoogleRuntime } from '../../.pi/lib/google-transport.js';
import type { GoogleReadOptions } from '../../.pi/lib/google-workspace-reads.js';
import type { NativeConfig } from './config.js';
import type { DurableHost } from './host.js';
import { Bindings, context as hostContext, type Target } from './ingress.js';
import { createGoogleReadBundle, nativeGoogleRuntime, type GoogleWorkspaceWrites } from './google-read.js';
import { textToolResult, type NativeBundle } from './registry.js';
import { UiRejectedError, type UiOrigin, type UiResult } from './telegram-bridge.js';
import { clean, type Presentation } from './telegram-ui.js';

/** Deletion confirmation lifetime. */
export const CALENDAR_TTL_MS = 10 * 60_000;
/** Longest time one transport signal may stay open. */
export const CALENDAR_DEADLINE_MS = 30_000;
const RETAIN_MS = 60 * 60_000;
const MAX_PENDING = 16;
const MAX_CONFIRMATIONS = 128;

type J = null | string | number | boolean | J[] | { [key: string]: J };
type Json = Record<string, unknown>;
type Body = { ok: boolean; result: J; error: { code: string; message: string } | null };
type Journal = {
  id: string; op: string; fingerprint: string; epoch: string; createdAt: number;
  status: 'claimed' | 'done';
  /** Validated model input, kept only until the outcome is recorded. */
  input: J;
  confirmationId: string | null;
  body: Body | null;
};
type Confirmation = {
  id: string; confirmKey: string; cancelKey: string;
  principal: string; actorId: number; chatId: number; epoch: string; createdAt: number; expiresAt: number;
  /** Set only after Telegram acknowledges the message that carries the buttons. */
  messageId: number | null;
  state: 'issued' | 'claimed' | 'done' | 'cancelled' | 'expired';
  commandId: string | null;
  /** Exact event version shown to the user. Approval never re-reads a new preview. */
  prepared: PreparedDelete;
  preview: J;
  outcome: { text: string; presented: boolean } | null;
};
export type CalendarNativeState = { version: 1; journal: Record<string, Journal>; confirmations: Record<string, Confirmation> };
/** Write journal (claim before transport) and persisted deletion confirmations. */
export const CalendarNative = defineDoc<CalendarNativeState>({
  kind: 'assistant.calendar-native', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ version: 1, journal: {}, confirmations: {} }),
});

type Run = (runtime: GoogleRuntime, args: string[], signal?: AbortSignal) => Promise<unknown>;
export interface NativeCalendarOptions {
  config: NativeConfig;
  /** Throws until the durable host exists. */
  host: () => DurableHost;
  present: (target: Target, presentation: Presentation) => Promise<{ messageId: number }>;
  /** Test seam for the Google transport. Defaults to the bounded gog runner with fixed-shape argument checks. */
  run?: Run;
  now?: () => number;
  randomKey?: () => string;
}
/** `key` is the 32 lowercase hex after the `gc:` callback prefix. */
export type CalendarCallbackRequest = UiOrigin & { messageId: number; key: string };

const DEFINITE_REJECTIONS = new Set(['CALENDAR_INPUT_INVALID', 'CALENDAR_EVENT_EXCLUDED', 'CALENDAR_EVENT_CHANGED', 'CALENDAR_OPERATION_CONFLICT', 'CALENDAR_AUTH_REQUIRED',
  'CALENDAR_WRITE_FORBIDDEN', 'CALENDAR_REQUEST_REJECTED', 'CALENDAR_WRITES_NOT_CONFIGURED', 'CALENDAR_BUSY', 'CALENDAR_CANCELLED']);
const UNRESOLVED = { code: 'CALENDAR_WRITE_UNRESOLVED', message: 'The Calendar change could not be verified. Check the event and Calendar authorization before retrying; reuse the same operation_key for a creation' };
const NOT_APPLIED = { code: 'CALENDAR_WRITE_NOT_APPLIED', message: 'The Calendar change was interrupted and the event is unchanged. Read the event again and retry only if the change is still wanted' };
const GENERIC = { code: 'CALENDAR_UNAVAILABLE', message: 'Calendar is unavailable. Check Google authorization and Calendar access before retrying' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const plain = <T,>(value: T): T => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
const failureBody = (error: { code: string; message: string }): Body => ({ ok: false, result: null, error: { code: error.code, message: error.message } });
const okBody = (result: J): Body => ({ ok: true, result, error: null });
const describe = (error: unknown) => error instanceof CalendarWriteError ? { code: error.code, message: error.message } : GENERIC;

/** Allows only the fixed Calendar API shapes the guarded domain builds. */
export const calendarTransport = (inner: typeof runGogJson = runGogJson): Run => async (runtime, args, signal) => {
  signal?.throwIfAborted();
  if (!hasGogRuntime(runtime)) throw new Error('Google Workspace is unavailable');
  const method = args[10];
  const flag = args[5];
  const write = flag === '--force';
  const fixed = args[0] === '--no-input' && args[1] === '--gmail-no-send' && args[2] === '--json' && args[3] === '--account' && args.slice(6, 10).join(' ') === 'api call calendar v3'
    && !(write && args.includes('--readonly'));
  const methods = write ? ['calendar.events.insert', 'calendar.events.patch', 'calendar.events.delete'] : ['calendar.calendarList.get', 'calendar.events.get'];
  if (!fixed || (flag !== '--force' && flag !== '--readonly') || !methods.includes(String(method)) || (write && !args.includes('--allow-write'))) throw new Error('Calendar command rejected');
  return inner({ binary: runtime.binary, passwordFile: runtime.passwordFile, gogHome: runtime.gogHome, args, ...(signal ? { signal } : {}), timeoutMs: CALENDAR_DEADLINE_MS,
    allowEmptyOutput: method === 'calendar.events.delete' });
};

export function createNativeCalendar(options: NativeCalendarOptions) {
  const { config } = options;
  const now = options.now ?? Date.now;
  const randomKey = options.randomKey ?? (() => randomUUID().replaceAll('-', ''));
  const allowed = config.transport.allowedUserId;
  const target: Target = { chatId: allowed };
  const domain = new CalendarWrites(options.run ?? calendarTransport());
  let runtime: GoogleRuntime | undefined;
  const google = (): GoogleRuntime => (runtime ??= nativeGoogleRuntime(config));
  let closed = false;
  let closing: Promise<void> | undefined;
  const inflight = new Set<Promise<unknown>>();
  let lock: Promise<unknown> = Promise.resolve();
  const active = new Set<string>();
  const lifetime = new AbortController();

  const track = <T,>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work)).catch(() => {});
    return work;
  };
  /** One Calendar change, confirmation or reconcile at a time. Waiting here never holds a transaction open. */
  const exclusive = <T,>(work: () => Promise<T>): Promise<T> => {
    const result = lock.then(work);
    lock = result.catch(() => {});
    return result;
  };
  const assertOpen = () => { if (closed) throw new Error('Calendar is closed'); };
  const root = () => { const host = options.host(); return { id: host.runtime.root.id, commit: <T,>(fn: (tx: Tx) => Promise<T>) => host.runtime.root.commit(async tx => plain(await fn(tx)), hostContext) }; };
  const deadline = (parent?: AbortSignal) => AbortSignal.any([lifetime.signal, AbortSignal.timeout(CALENDAR_DEADLINE_MS), ...(parent ? [parent] : [])]);

  async function authority(tx: Tx, conversationId?: ConversationId): Promise<{ epoch: string } | undefined> {
    const state = await tx.doc(Bindings, root().id);
    const epoch = String(state.epoch);
    const cid = state.epochs[epoch];
    if (conversationId !== undefined && cid !== conversationId) return undefined;
    const sources = Object.values(state.sources).filter(source => cid !== undefined && source.conversationId === cid && !source.cancelled);
    if (!sources.length || sources.some(source => source.principal !== config.principal || source.chatId !== allowed || source.threadId !== null)) return undefined;
    return { epoch };
  }
  const originOk = (request: UiOrigin) => request.actorId === allowed && request.principal === config.principal && request.target.chatId === allowed && request.target.threadId === undefined;

  function prune(state: CalendarNativeState): void {
    const time = now();
    for (const [id, item] of Object.entries(state.confirmations)) {
      if (item.state === 'issued' && item.expiresAt <= time) item.state = 'expired';
      if (item.state !== 'claimed' && item.expiresAt + RETAIN_MS < time) delete state.confirmations[id];
    }
    const items = Object.values(state.confirmations).filter(item => item.state !== 'claimed').sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items.slice(0, Math.max(0, items.length - MAX_CONFIRMATIONS))) delete state.confirmations[item.id];
    // Keep call receipts: an old Harness task can still replay its original taskId.
    // Deleting a claim or receipt would turn that replay into a fresh mutation.
    // Completed entries discard their input; C6 owns storage/retirement measurement.
  }

  const bodyFromReconcile = (operation: string, result: Reconciliation): Body =>
    result.status === 'applied' ? okBody({ operation, event: result.event as J }) : failureBody(result.status === 'not_applied' ? NOT_APPLIED : UNRESOLVED);
  const deleteText = (result: Reconciliation) => result.status === 'applied' ? 'Event deleted.'
    : result.status === 'not_applied' ? 'The event was not deleted. Request deletion again if you still want it.' : UNRESOLVED.message;

  // ---- Model tool dispatch --------------------------------------------------------------------
  type ToolApi = Pick<ToolExecutionApi, 'conversationId' | 'taskId' | 'commit'>;
  type Claim = { kind: 'unauthorized' } | { kind: 'mismatch' } | { kind: 'done'; body: Body } | { kind: 'recover'; entry: Journal } | { kind: 'new'; epoch: string };

  async function dispatch(input: Json, api: ToolApi, ctx: Context): Promise<ReturnType<typeof textToolResult>> {
    const op = String(input.operation);
    const reply = (body: Body) => textToolResult(body as never, !body.ok);
    if (closed) return reply(failureBody(GENERIC));
    // Harness task IDs are unique per invocation and stable on replay. Provider call IDs may repeat.
    if (!Number.isSafeInteger(api.taskId) || api.taskId < 0) return reply(failureBody(GENERIC));
    const taskId = String(api.taskId);
    const fingerprint = hash(JSON.stringify(input));
    const commit = <T,>(fn: (tx: Tx) => Promise<T>) => api.commit(async tx => plain(await fn(tx)), ctx);
    const claim = async (): Promise<Claim> => commit(async (tx): Promise<Claim> => {
      const authorityNow = await authority(tx, api.conversationId);
      if (!authorityNow) return { kind: 'unauthorized' };
      const state = await tx.doc(CalendarNative, root().id);
      prune(state);
      const existing = state.journal[taskId];
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.op !== op || existing.epoch !== authorityNow.epoch) return { kind: 'mismatch' };
        return existing.status === 'done' && existing.body ? { kind: 'done', body: existing.body } : { kind: 'recover', entry: { ...existing } };
      }
      state.journal[taskId] = { id: taskId, op, fingerprint, epoch: authorityNow.epoch, createdAt: now(), status: 'claimed', input: input as unknown as J, confirmationId: null, body: null };
      return { kind: 'new', epoch: authorityNow.epoch };
    });
    const settle = (body: Body) => commit(async tx => {
      const entry = (await tx.doc(CalendarNative, root().id)).journal[taskId];
      if (entry && entry.status !== 'done') { entry.status = 'done'; entry.body = body; entry.input = null; }
      return entry?.body ?? body;
    });
    /** Fresh authority and still-claimed intent, checked after every async permission/read and immediately before the write. */
    const assertWrite = (epoch: string) => async () => {
      if (closed) throw new Error('closed');
      const valid = await commit(async tx => {
        const authorityNow = await authority(tx, api.conversationId);
        const entry = (await tx.doc(CalendarNative, root().id)).journal[taskId];
        return !!authorityNow && authorityNow.epoch === epoch && entry?.status === 'claimed';
      });
      if (!valid) throw new Error('authority');
    };

    const outcome = op === 'calendar_request_delete'
      ? await requestDelete()
      : await exclusive(async (): Promise<Body | 'unauthorized' | 'mismatch'> => {
        const state = await claim();
        if (state.kind === 'unauthorized' || state.kind === 'mismatch') return state.kind;
        if (state.kind === 'done') return state.body;
        const signal = deadline(ctx.abortSignal);
        let body: Body;
        if (state.kind === 'recover') {
          // A claimed write may or may not have reached Google. Inspect, never repeat.
          body = bodyFromReconcile(op, await domain.reconcile(google(), { operation: op as 'calendar_create', input: state.entry.input as unknown as Json }, signal));
        } else {
          try {
            body = okBody(await domain.execute(google(), input, signal, { assertAuthority: assertWrite(state.epoch) }) as J);
          } catch (error) {
            if (ctx.abortSignal?.aborted) throw error;
            if (error instanceof CalendarWriteError && DEFINITE_REJECTIONS.has(error.code)) body = failureBody(error);
            else body = closed || signal.aborted ? failureBody(UNRESOLVED)
              : bodyFromReconcile(op, await domain.reconcile(google(), { operation: op as 'calendar_create', input }, signal));
          }
        }
        // A cancelled transport may still have reached Google. Keep the claim so a
        // restarted task can reconcile it with a fresh read-only deadline.
        return closed || signal.aborted ? body : settle(body);
      });
    if (outcome === 'unauthorized') return reply(failureBody({ code: 'CALENDAR_UNAVAILABLE', message: 'Calendar changes require the current private conversation' }));
    if (outcome === 'mismatch') return reply(failureBody({ code: 'CALENDAR_WRITE_UNRESOLVED', message: 'This Calendar call no longer matches its recorded request. Nothing was repeated; read the event and retry if needed' }));
    return reply(outcome);

    async function requestDelete(): Promise<Body | 'unauthorized' | 'mismatch'> {
      const state = await exclusive(claim);
      if (state.kind === 'unauthorized' || state.kind === 'mismatch') return state.kind;
      if (state.kind === 'done') return state.body;
      if (state.kind === 'recover' && state.entry.confirmationId) {
        // The preview was prepared before the interruption. Never present it again from here.
        const id = state.entry.confirmationId;
        return exclusive(() => commit(async tx => {
          const document = await tx.doc(CalendarNative, root().id);
          const item = document.confirmations[id];
          const entry = document.journal[taskId]!;
          if (item?.messageId != null && (item.state === 'issued' || item.state === 'claimed' || item.state === 'done')) entry.body = okBody(summary(item.preview));
          else {
            if (item && item.state === 'issued') item.state = 'expired';
            entry.body = failureBody({ code: 'CALENDAR_CONFIRMATION_UNAVAILABLE', message: 'The confirmation could not be confirmed as shown. Nothing was deleted; request deletion again' });
          }
          entry.status = 'done'; entry.input = null;
          return entry.body;
        }));
      }
      const epoch = state.kind === 'new' ? state.epoch : state.entry.epoch;
      const signal = deadline(ctx.abortSignal);
      const prepared = await exclusive(async (): Promise<Body | { event: Json; prepared: PreparedDelete }> => {
        try { return await domain.prepareDelete(google(), input, signal); }
        catch (error) { if (ctx.abortSignal?.aborted) throw error; return settle(failureBody(describe(error))); }
      });
      if ('ok' in prepared) return prepared;
      const issued = await exclusive(() => commit(async (tx): Promise<{ item: Confirmation } | Body> => {
        const authorityNow = await authority(tx, api.conversationId);
        const document = await tx.doc(CalendarNative, root().id);
        const entry = document.journal[taskId];
        if (!authorityNow || authorityNow.epoch !== epoch || entry?.status !== 'claimed') return failureBody({ code: 'CALENDAR_CANCELLED', message: 'Calendar change cancelled before submission' });
        prune(document);
        if (Object.values(document.confirmations).filter(item => item.state === 'issued').length >= MAX_PENDING) {
          entry.status = 'done'; entry.input = null; entry.body = failureBody({ code: 'CALENDAR_BUSY', message: 'Too many pending confirmations. Cancel one or wait for expiry' });
          return entry.body;
        }
        const item: Confirmation = {
          id: randomKey(), confirmKey: randomKey(), cancelKey: randomKey(), principal: config.principal, actorId: allowed, chatId: allowed, epoch: authorityNow.epoch,
          createdAt: now(), expiresAt: now() + CALENDAR_TTL_MS, messageId: null, state: 'issued', commandId: null,
          prepared: prepared.prepared, preview: preview(prepared.event), outcome: null,
        };
        document.confirmations[item.id] = item;
        entry.confirmationId = item.id;
        return { item };
      }));
      if ('ok' in issued) return settle(issued);
      const { item } = issued;
      let messageId: number | undefined;
      try {
        const sent = await track(options.present(target, confirmationView(item)));
        if (Number.isSafeInteger(sent.messageId) && sent.messageId > 0) messageId = sent.messageId;
      } catch { /* Unknown delivery never authorizes. */ }
      return exclusive(() => commit(async tx => {
        const document = await tx.doc(CalendarNative, root().id);
        const stored = document.confirmations[item.id];
        const entry = document.journal[taskId]!;
        if (entry.status === 'done') return entry.body!;
        if (messageId !== undefined && stored?.state === 'issued') {
          stored.messageId = messageId;
          entry.body = okBody(summary(stored.preview));
        } else {
          if (stored && stored.state === 'issued') stored.state = 'expired';
          entry.body = failureBody({ code: 'CALENDAR_CONFIRMATION_UNAVAILABLE', message: 'The confirmation could not be shown. Nothing was deleted; request deletion again' });
        }
        entry.status = 'done'; entry.input = null;
        return entry.body;
      }));
    }
  }

  // ---- Confirmation presentation ----------------------------------------------------------------
  function preview(event: Json): J {
    const time = (value: unknown) => { const item = (value ?? {}) as Json; return Object.fromEntries(['date', 'dateTime', 'timeZone'].flatMap(name => typeof item[name] === 'string' ? [[name, item[name] as string]] : [])); };
    return { id: String(event.id ?? ''), summary: typeof event.summary === 'string' ? event.summary : '', calendar: String(event.calendar ?? ''), start: time(event.start), end: time(event.end) };
  }
  const summary = (value: J): J => ({ operation: 'calendar_request_delete', status: 'confirmation_required', event: value, message: 'Confirmation buttons were sent to the user. The event has not been deleted. Wait for the user to decide.' });
  function confirmationView(item: Confirmation): Presentation {
    const event = item.preview as { summary: string; calendar: string; start: Json; end: Json };
    const start = event.start as Json, end = event.end as Json;
    return {
      text: clean(`Delete event: ${event.summary || 'Untitled'}\nCalendar: ${event.calendar === 'personal' ? 'Personal' : 'Things to Do'}\nStart: ${start.date ?? start.dateTime}\nEnd: ${end.date ?? end.dateTime}${end.date ? ' (exclusive)' : ''}\n${start.timeZone ? `Time zone: ${start.timeZone}\n` : ''}\nThis confirmation expires in 10 minutes and applies only to this version of the event.`),
      buttons: [[{ text: 'Confirm deletion', callback: `gc:${item.confirmKey}` }, { text: 'Cancel', callback: `gc:${item.cancelKey}` }]],
    };
  }

  // ---- Direct confirmation callback --------------------------------------------------------------
  type CallbackClaim = { kind: 'reject'; message: string } | { kind: 'run' | 'recover' | 'deliver'; item: Confirmation };
  async function callback(request: CalendarCallbackRequest): Promise<UiResult> {
    assertOpen();
    if (!originOk(request) || !/^[a-f0-9]{32}$/.test(request.key)) throw new UiRejectedError('This action is unavailable.');
    const key = request.key;
    const expired = (): CallbackClaim => ({ kind: 'reject', message: 'This confirmation expired. Ask for a fresh deletion preview.' });
    const claim = await exclusive(() => root().commit(async (tx): Promise<CallbackClaim> => {
      const authorityNow = await authority(tx);
      const document = await tx.doc(CalendarNative, root().id);
      const item = Object.values(document.confirmations).find(candidate => candidate.confirmKey === key || candidate.cancelKey === key);
      if (!item || item.principal !== request.principal || item.actorId !== request.actorId || item.chatId !== request.target.chatId) return expired();
      if (!authorityNow || authorityNow.epoch !== item.epoch || item.state === 'expired') return expired();
      const confirm = item.confirmKey === key;
      if (item.state !== 'issued') {
        const same = item.commandId === request.commandId && item.messageId === request.messageId;
        if (!same || (confirm ? item.state === 'cancelled' : item.state !== 'cancelled')) return { kind: 'reject', message: 'That button was already used.' };
        return { kind: item.outcome ? 'deliver' : 'recover', item: { ...item } };
      }
      if (item.messageId === null || item.messageId !== request.messageId || item.expiresAt <= now()) return expired();
      item.commandId = request.commandId;
      if (!confirm) { item.state = 'cancelled'; item.outcome = { text: 'Cancelled. The event was not deleted.', presented: false }; return { kind: 'deliver', item: { ...item } }; }
      item.state = 'claimed';
      return { kind: 'run', item: { ...item } };
    }));
    if (claim.kind === 'reject') throw new UiRejectedError(claim.message);
    const id = claim.item.id;
    if (active.has(id)) return { toast: 'Already in progress' };
    active.add(id);
    try {
      let text: string | undefined;
      if (claim.kind === 'deliver' && claim.item.outcome) text = claim.item.outcome.text;
      else {
        text = await exclusive(async () => {
          const current = await root().commit(async tx => (await tx.doc(CalendarNative, root().id)).confirmations[id]);
          if (!current) return undefined;
          if (current.outcome) return current.outcome.text;
          let message: string;
          const signal = deadline();
          if (claim.kind === 'recover') {
            // A claimed deletion may have reached Google. Inspect, never repeat.
            message = deleteText(await domain.reconcile(google(), { operation: 'calendar_request_delete', prepared: current.prepared }, signal));
          } else {
            try {
              await domain.executePreparedDelete(google(), current.prepared, signal, { assertAuthority: async () => {
                if (closed) throw new Error('closed');
                const valid = await root().commit(async tx => {
                  const authorityNow = await authority(tx);
                  const stored = (await tx.doc(CalendarNative, root().id)).confirmations[id];
                  return !!authorityNow && !!stored && authorityNow.epoch === stored.epoch && stored.state === 'claimed' && stored.commandId === request.commandId && stored.expiresAt > now();
                });
                if (!valid) throw new Error('authority');
              } });
              message = 'Event deleted.';
            } catch (error) {
              if (error instanceof CalendarWriteError && DEFINITE_REJECTIONS.has(error.code)) message = `${error.message.replace(/\.$/, '')}. The event was not deleted.`;
              else message = closed || signal.aborted ? UNRESOLVED.message
                : deleteText(await domain.reconcile(google(), { operation: 'calendar_request_delete', prepared: current.prepared }, signal));
            }
          }
          await root().commit(async tx => {
            const stored = (await tx.doc(CalendarNative, root().id)).confirmations[id];
            if (stored && !stored.outcome && !closed && !signal.aborted) { stored.state = 'done'; stored.outcome = { text: message, presented: false }; }
          });
          return message;
        });
      }
      if (text === undefined) throw new UiRejectedError('This confirmation expired. Ask for a fresh deletion preview.');
      const presented = await root().commit(async tx => (await tx.doc(CalendarNative, root().id)).confirmations[id]?.outcome?.presented === true);
      if (presented) return { toast: 'Already applied' };
      try {
        await track(options.present(target, { text: clean(text) }));
        await root().commit(async tx => { const stored = (await tx.doc(CalendarNative, root().id)).confirmations[id]; if (stored?.outcome) stored.outcome.presented = true; });
      } catch { return { toast: 'Could not send the result. Check the event before retrying.' }; }
      return {};
    } finally { active.delete(id); }
  }

  async function invalidate(): Promise<void> {
    if (closed) return;
    domain.clear();
    await root().commit(async tx => {
      for (const item of Object.values((await tx.doc(CalendarNative, root().id)).confirmations)) if (item.state === 'issued' || item.state === 'claimed') item.state = 'expired';
    });
  }

  const writes: GoogleWorkspaceWrites = { dispatch: (input, api, ctx) => track(dispatch(input, api as ToolApi, ctx)) };
  function bundle(): NativeBundle {
    const overrides: Partial<GoogleReadOptions> = options.run ? { run: options.run } : {};
    return { ...createGoogleReadBundle(config, overrides, writes, 'google-workspace'), close };
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    lifetime.abort(new Error('Calendar is closing'));
    domain.clear();
    closing = (async () => { await Promise.allSettled([...inflight]); })();
    return closing;
  }
  const entry = <A, R>(work: (request: A) => Promise<R>) => (request: A): Promise<R> => {
    if (closed) return Promise.reject(new Error('Calendar is closed'));
    return track(work(request));
  };
  return { bundle, callback: entry(callback), invalidate: () => closed ? Promise.resolve() : track(invalidate()), close };
}
export type NativeCalendar = ReturnType<typeof createNativeCalendar>;
