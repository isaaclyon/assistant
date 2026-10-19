import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { StringEnum, Type, validateToolArguments, type Static } from '@earendil-works/pi-ai';
import type { JsonValue } from '@earendil-works/chord';
import { defineTool, type ConversationId, type JsonObject, type TaskId, type ToolExecutionApi, type Tx } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { PrepareMemoryIntentInput } from './memory-executor.js';
import { MemoryError, type MemoryDomain, type MemoryDraft, type MemoryNote, type MemoryPatch } from './memory-domain.js';
import { DRAFT_TTL_MS, MemoryDrafts, draftOf, invalidateMemoryDrafts, pruneDrafts } from './memory-drafts.js';
import {
  MemoryOperations, type AuthenticatedMemoryCallback, type MemoryBinding, type MemoryIntent, type MemoryOperation, type MemoryOperationOutcome, type createMemoryOperations,
} from './operations.js';
import type { NativeTool } from './registry.js';

export { MemoryError, createCanonicalMemoryDomain, assertMemoryAvailable } from './memory-domain.js';
export type { MemoryDomain, MemoryDraft, MemoryNote, MemoryPatch } from './memory-domain.js';
export { MemoryDrafts, invalidateMemoryDrafts } from './memory-drafts.js';

/** Confirmation lifetime for delete and share (C0 D3). */
export const CONFIRMATION_TTL_MS = 10 * 60_000;
export type MemoryConfirmationPreview = { title: string; type: string; updated: string };
/** Trusted presenter (Telegram). It receives the one-use approval token inside `operation`; nothing here returns it to the model. */
export interface MemoryConfirmationPresenter {
  present(request: { conversationId: ConversationId; operation: MemoryOperation; preview: MemoryConfirmationPreview }): Promise<{ messageId: string }>;
}
export type MemoryOperationsApi = Pick<ReturnType<typeof createMemoryOperations>, 'prepare' | 'authorize' | 'presented' | 'presentationFailed' | 'decide' | 'invalidate'>;
export interface MemoryToolOptions {
  operations: MemoryOperationsApi;
  /** Name/version of the installed executor; operations only run with an exactly matching executor. */
  handler: MemoryOperation['handler'];
  domain: MemoryDomain;
  /** Current principal, target and epoch for a conversation, from trusted host state. Undefined rejects the call. */
  resolveBinding(tx: Tx, conversationId: ConversationId): Promise<MemoryBinding | undefined>;
  presenter: MemoryConfirmationPresenter;
  /**
   * Builds the complete deterministic intent (exact pre and post revisions) from explicit host-owned
   * root and view. Production: `input => prepareMemoryIntent({ root, view, forbiddenRoots }, input)`.
   * The tool supplies note id and timestamp; the model never chooses root, view or time.
   */
  prepareIntent(input: PrepareMemoryIntentInput): Promise<{ intent: MemoryIntent }>;
  now?: () => number;
  randomUUID?: () => string;
}

const Id = Type.String({ format: 'uuid' });
const Revision = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });
const Tags = Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 30 });
const Status = StringEnum(['active', 'superseded', 'archived'] as const);
const Decay = StringEnum(['durable', 'fading'] as const);
const NoteType = StringEnum(['person', 'preference', 'event', 'list', 'recipe', 'purchase', 'reference'] as const);
const Metadata = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  tags: Type.Optional(Tags), status: Type.Optional(Status),
  decay: Type.Optional(Type.Union([Decay, Type.Null()])),
}, { additionalProperties: false, minProperties: 1 });
const Draft = Type.Object({ type: NoteType,
  title: Type.String({ minLength: 1, maxLength: 200 }), tags: Type.Optional(Tags),
  body: Type.String({ maxLength: 200_000 }), decay: Type.Optional(Decay),
}, { additionalProperties: false });
export const memoryOperationParameters = Type.Union([
  Type.Object({ action: Type.Literal('read'), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('create'), draft: Draft }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('create'), draftToken: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('update'), id: Id, revision: Revision,
    edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String({ minLength: 1, maxLength: 200_000 }),
      newText: Type.String({ maxLength: 200_000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 })),
    append: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })), set: Type.Optional(Metadata),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('list'), types: Type.Optional(Type.Array(NoteType, { minItems: 1, maxItems: 7, uniqueItems: true })),
    statuses: Type.Optional(Type.Array(Status, { minItems: 1, maxItems: 3, uniqueItems: true })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}:[0-9]{1,10}$' })),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('delete'), id: Id, revision: Revision }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('share'), id: Id, revision: Revision }, { additionalProperties: false }),
]);
// Provider function schemas require an object root without top-level unions.
// Keep the standard flat arguments on the wire; validate the exact action
// branch again before invoking any domain service or preparing an operation.
export const memoryToolParameters = Type.Object({
  action: StringEnum(['read', 'create', 'update', 'list', 'delete', 'share'] as const),
  id: Type.Optional(Id), revision: Type.Optional(Revision),
  draft: Type.Optional(Draft), draftToken: Type.Optional(Id),
  edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String({ minLength: 1, maxLength: 200_000 }),
    newText: Type.String({ maxLength: 200_000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 })),
  append: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })), set: Type.Optional(Metadata),
  types: Type.Optional(Type.Array(NoteType, { minItems: 1, maxItems: 7, uniqueItems: true })),
  statuses: Type.Optional(Type.Array(Status, { minItems: 1, maxItems: 3, uniqueItems: true })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}:[0-9]{1,10}$' })),
}, { additionalProperties: false });
export const MEMORY_TOOL_DESCRIPTION = 'Create, read, update, list, delete, or share Markdown memories. Create with a draft to review possible duplicates, then commit its draftToken. Updates use exact oldText/newText edits, append, and metadata set with a required revision. Delete/share open user-only confirmation buttons.';
/** Usage guidance for the instruction/skill bundle; the native tool shape has no guideline field. */
export const MEMORY_TOOL_GUIDELINES = [
  'Use assistant_memory for full-note reads and changes. Persist only memories the user explicitly asks to save.',
  'Create with draft, inspect possibleDuplicates, then create with draftToken for a distinct note. Update an existing note when it covers the same fact. Reuse the token on retries; tokens expire after ten minutes or session reset.',
  'Notes rank by usage. Person, preference, recipe, and reference notes are durable; list, event, and purchase notes fade when unused. Set decay to fading for a time-bound fact or idea of a durable type, or durable for a list or event that stays relevant; null restores the type default.',
  'Read before updating. Supply revision and edits (unique oldText/newText), append (Markdown at the end), and/or set (metadata). Edits run sequentially, then append, then one atomic save. Preserve unrelated content. Reread on conflict; restart list pagination on CURSOR_CONFLICT.',
  'Store stable facts in person notes, collections in lists, dated plans in events. Follow explicit list names. Confirm the actual saved type and title only when status is saved; review_required, confirmation_required and uncertain mean the change is not confirmed saved.',
  'Delete and share open user-only Telegram confirmations. Never bypass confirmation through the CLI or filesystem. Use assistant_memory_search for discovery and list for filtered browsing. CLI is for maintenance only.',
];

type Failure = { code: string; message: string };
type Details = { ok: boolean; status: string; result?: JsonValue; error?: Failure };
function fail(code: string, message: string): never { throw new MemoryError(code, message); }
function failure(error: unknown): Failure {
  const coded = error as { code?: unknown; message?: unknown };
  return error instanceof MemoryError || (error instanceof Error && error.name === 'MemoryError' && typeof coded.code === 'string')
    ? { code: String(coded.code), message: String(coded.message) }
    : { code: 'MEMORY_UNAVAILABLE', message: 'Memory is temporarily unavailable' };
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
const RETRY_SHARED = new Set<MemoryOperation['status']>(['prepared', 'authorized', 'executing', 'succeeded', 'uncertain']);

function findOperation(state: { operations: MemoryOperation[] }, id: string): MemoryOperation | undefined { return state.operations.find(op => op.id === id); }

/** User-facing text for a settled operation, shared by tool results and Telegram callbacks. */
export function memoryOutcomeMessage(op: Readonly<MemoryOperation>): string {
  const git = op.result?.git === 'uncertain' ? ' Its local Git commit could not be confirmed.' : '';
  switch (op.status) {
    case 'succeeded': return ({ delete: 'Memory deleted.', share: 'Memory shared with the household.', create: 'Memory saved.', update: 'Memory updated.', append: 'Memory updated.' })[op.intent.action] + git;
    case 'uncertain': return `${op.intent.action === 'delete' || op.intent.action === 'share' ? 'The change' : 'The memory change'} may or may not have been applied.${op.result ? ' The note was saved, but Git is uncertain.' : ''} Check the note before retrying.`;
    case 'interrupted': return op.reason === 'User denied' ? 'Cancelled. The memory was not changed.' : 'The memory was not changed (request expired or no longer authorized).';
    case 'blocked': return 'The memory was not changed (the memory executor is unavailable).';
    default: return 'The memory change is still in progress.';
  }
}

/** Trusted callback path for a delete/share confirmation. `callback` comes from authenticated ingress. */
export async function decideMemoryCallback(tx: Tx, operations: Pick<MemoryOperationsApi, 'decide'>, conversationId: ConversationId, callback: AuthenticatedMemoryCallback):
  Promise<{ accepted: false } | { accepted: true; operationId: string; taskId: TaskId<MemoryOperationOutcome> | null }> {
  const decision = await operations.decide(tx, conversationId, callback);
  if (!decision.accepted) return { accepted: false };
  const op = (await tx.doc(MemoryOperations, conversationId)).operations.find(item => item.approval.token === callback.token);
  if (!op) throw new Error('Decided memory operation is missing');
  return { accepted: true, operationId: op.id, taskId: decision.taskId };
}
/** For the host: invalidate pending drafts and confirmations on new/reload/reset. */
export async function invalidateMemoryState(tx: Tx, operations: Pick<MemoryOperationsApi, 'invalidate'>, conversationId: ConversationId, nextEpoch: string, reason: 'new' | 'reload' | 'reset'): Promise<void> {
  await invalidateMemoryDrafts(tx, conversationId, nextEpoch);
  await operations.invalidate(tx, conversationId, nextEpoch, reason);
}
export async function readMemoryOperation(tx: Tx, conversationId: ConversationId, id: string): Promise<MemoryOperation | undefined> {
  const op = findOperation(await tx.doc(MemoryOperations, conversationId), id);
  return op ? copy(op) : undefined;
}

export function createMemoryToolService(options: MemoryToolOptions) {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? nodeRandomUUID;
  const { operations, domain } = options;

  async function binding(tx: Tx, conversationId: ConversationId): Promise<MemoryBinding> {
    const value = await options.resolveBinding(tx, conversationId);
    if (!value) fail('UNAVAILABLE', 'Memory tools require a configured bridge session');
    return value;
  }
  /** Wait for the native task of an authorized operation, then report the persisted record. */
  async function settle(api: ToolExecutionApi, context: Context, operationId: string, taskId: TaskId<MemoryOperationOutcome> | null): Promise<MemoryOperation> {
    if (taskId) await api.waitForTask(taskId, context);
    const op = await api.commit(tx => readMemoryOperation(tx, api.conversationId, operationId), context);
    if (!op) fail('MEMORY_UNAVAILABLE', 'Memory is temporarily unavailable');
    return op;
  }
  function settled(op: MemoryOperation): Details {
    const base = { operation: op.intent.action, id: op.intent.noteId };
    if (op.status === 'succeeded') {
      return { ok: true, status: 'saved', result: { ...base, revision: op.result?.revision ?? null, git: op.result?.git ?? 'not-requested', receipt: op.result?.receipt ?? null, message: memoryOutcomeMessage(op) } };
    }
    if (op.status === 'uncertain') {
      // The Markdown effect may have happened. Never report failure or success.
      return { ok: false, status: 'uncertain', error: { code: 'OUTCOME_UNCERTAIN', message: `${op.reason ?? 'Outcome unknown'}. Read the note before retrying; do not repeat the change blindly.` },
        result: { ...base, saved: op.result !== null, git: op.result?.git ?? null, revision: op.result?.revision ?? null } };
    }
    if (op.status === 'interrupted' || op.status === 'blocked') return { ok: false, status: 'error', error: { code: op.status === 'blocked' ? 'EXECUTOR_UNAVAILABLE' : 'NOT_APPLIED', message: `${memoryOutcomeMessage(op)} Nothing was written.` } };
    return { ok: false, status: 'error', error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory change is still in progress; read the note to check' } };
  }

  async function prepareDraft(api: ToolExecutionApi, context: Context, raw: unknown): Promise<Details> {
    const draft = domain.validateDraft(raw);
    const page = await domain.findDuplicates(draft);
    const token = uuid();
    await api.commit(async tx => {
      const current = await binding(tx, api.conversationId);
      const state = await tx.doc(MemoryDrafts, api.conversationId);
      pruneDrafts(state, current.epoch, now());
      state.drafts.push({ token, noteId: uuid(), draft: copy(draft) as unknown as JsonObject, principal: current.principal, target: copy(current.target), epoch: current.epoch,
        createdAt: now(), expiresAt: now() + DRAFT_TTL_MS, consumed: null });
    }, context);
    return { ok: true, status: 'review_required', result: { possibleDuplicates: page.results as JsonValue, retrieval: (page.retrieval ?? { mode: 'keyword' }) as JsonValue, draftToken: token,
      instruction: 'Compare these related notes. Update an existing note if it covers the same fact; otherwise create using this token. Ask if materially ambiguous.' } };
  }

  async function commitDraft(api: ToolExecutionApi, context: Context, token: string): Promise<Details> {
    const stale = (): never => fail('STALE_ACTION', 'Prepare the memory again before creating it');
    /** Reads the draft under the current binding. Each failed check looks the same so a token cannot be probed. */
    const inspect = async (tx: Tx) => {
      const current = await binding(tx, api.conversationId);
      const state = await tx.doc(MemoryDrafts, api.conversationId);
      if (state.version !== 1) throw new Error('Unsupported memory draft document version');
      const record = state.drafts.find(item => item.token === token);
      if (!record) return stale();
      if (record.consumed) {
        const existing = findOperation(await tx.doc(MemoryOperations, api.conversationId), record.consumed.operationId);
        if (!existing || existing.binding.principal !== current.principal || existing.binding.epoch !== current.epoch) return stale();
        return { current, state, record, existing };
      }
      if (record.expiresAt <= now() || record.epoch !== current.epoch || state.epoch !== current.epoch || record.principal !== current.principal ||
        record.target.chatId !== current.target.chatId || record.target.threadId !== current.target.threadId) return stale();
      return { current, state, record, existing: undefined };
    };
    const seen = await api.commit(async tx => {
      const found = await inspect(tx);
      return { consumed: found.existing ? { operationId: found.existing.id, taskId: found.existing.taskId } : undefined, draft: copy(found.record) };
    }, context);
    let intent: MemoryIntent | undefined;
    if (!seen.consumed) {
      // Fixed note id and timestamp come from the stored draft, so every attempt plans identical bytes.
      intent = (await options.prepareIntent({ action: 'create', request: copy(seen.draft.draft), noteId: seen.draft.noteId, timestamp: new Date(seen.draft.createdAt).toISOString() })).intent;
    }
    const prepared = await api.commit(async tx => {
      const { current, record, existing } = await inspect(tx);
      if (existing) return { operationId: existing.id, taskId: existing.taskId };
      if (!intent) return stale();
      const op = await operations.prepare(tx, api.conversationId, { id: `create-${record.token}`, binding: current, handler: options.handler, expiresAt: record.expiresAt, intent });
      const authorized = await operations.authorize(tx, api.conversationId, op.id);
      if (!authorized.accepted) return stale();
      record.consumed = { operationId: op.id, at: now() };
      return { operationId: op.id, taskId: authorized.taskId as TaskId<MemoryOperationOutcome> | null };
    }, context);
    return settled(await settle(api, context, prepared.operationId, prepared.taskId));
  }

  async function update(api: ToolExecutionApi, context: Context, args: { id: string; revision: string;
    edits?: Array<{ oldText: string; newText: string }>; append?: string; set?: Pick<MemoryPatch, 'title' | 'tags' | 'status' | 'decay'> }): Promise<Details> {
    const patch: MemoryPatch = { ...args.set,
      ...(args.edits === undefined ? {} : { bodyEdits: args.edits.map(edit => ({ expectedText: edit.oldText, replacementText: edit.newText })) }),
      ...(args.append === undefined ? {} : { append: args.append }) };
    if (Object.keys(patch).length === 0) fail('INVALID_INPUT', 'Use targeted text edits or metadata changes; sharing requires confirmation');
    const action = Object.keys(patch).length === 1 && patch.append !== undefined ? 'append' : 'update';
    const key = (current: MemoryBinding) => `${action}-${createHash('sha256').update(canonical([api.conversationId, current.principal, current.epoch, args.id, args.revision, patch])).digest('hex').slice(0, 40)}`;
    /** A retry of the same change at the same revision joins the earlier operation instead of writing again. */
    const shared = (state: { operations: MemoryOperation[] }, base: string) => {
      for (let attempt = 1, id = base; ; attempt++, id = `${base}-${attempt - 1}`) {
        const existing = findOperation(state, id);
        if (!existing) return { id, joined: undefined };
        if (RETRY_SHARED.has(existing.status)) return { id, joined: existing };
      }
    };
    const peeked = await api.commit(async tx => shared(await tx.doc(MemoryOperations, api.conversationId), key(await binding(tx, api.conversationId))).joined?.id, context);
    let intent: MemoryIntent | undefined;
    if (!peeked) {
      const note = await domain.read(args.id);
      if (note.revision !== args.revision) fail('REVISION_CONFLICT', 'Memory changed since it was read');
      const timestamp = new Date(now()).toISOString();
      intent = (await options.prepareIntent(action === 'append'
        ? { action: 'append', noteId: note.id, append: patch.append!, timestamp }
        : { action: 'update', noteId: note.id, patch: copy(patch) as unknown as JsonObject, timestamp })).intent;
      if (intent.preRevision !== args.revision) fail('REVISION_CONFLICT', 'Memory changed since it was read');
    }
    const prepared = await api.commit(async tx => {
      const current = await binding(tx, api.conversationId);
      const { id, joined } = shared(await tx.doc(MemoryOperations, api.conversationId), key(current));
      if (joined) return { operationId: joined.id, taskId: joined.taskId };
      if (!intent) fail('STALE_ACTION', 'Memory changed since it was read');
      const op = await operations.prepare(tx, api.conversationId, { id, binding: current, handler: options.handler, expiresAt: now() + CONFIRMATION_TTL_MS, intent });
      const authorized = await operations.authorize(tx, api.conversationId, op.id);
      if (!authorized.accepted) fail('UNAVAILABLE', 'Memory changes are not currently authorized or the memory executor is unavailable');
      return { operationId: op.id, taskId: authorized.taskId as TaskId<MemoryOperationOutcome> | null };
    }, context);
    return settled(await settle(api, context, prepared.operationId, prepared.taskId));
  }

  async function requestConfirmation(api: ToolExecutionApi, context: Context, action: 'delete' | 'share', args: { id: string; revision: string }): Promise<Details> {
    const note: MemoryNote = await domain.read(args.id);
    if (note.revision !== args.revision) fail('REVISION_CONFLICT', 'Memory changed since it was read');
    if (action === 'share' && note.scope !== 'personal') fail('INVALID_INPUT', 'This note is already household-visible');
    const timestamp = new Date(now()).toISOString();
    const { intent } = await options.prepareIntent(action === 'share'
      ? { action: 'share', noteId: note.id, patch: { scope: 'household' }, timestamp } : { action: 'delete', noteId: note.id, timestamp });
    if (intent.preRevision !== args.revision) fail('REVISION_CONFLICT', 'Memory changed since it was read');
    const preview = { title: String(note.title), type: String(note.type), updated: String(note.updated) };
    const operation = await api.commit(async tx => operations.prepare(tx, api.conversationId, { id: uuid(), binding: await binding(tx, api.conversationId), handler: options.handler,
      expiresAt: now() + CONFIRMATION_TTL_MS, intent }), context);
    let messageId: string;
    try { ({ messageId } = await options.presenter.present({ conversationId: api.conversationId, operation: copy(operation), preview })); }
    catch {
      await api.commit(tx => operations.presentationFailed(tx, api.conversationId, operation.id), context);
      fail('PRESENTATION_FAILED', 'The confirmation buttons could not be delivered; nothing has changed');
    }
    const recorded = await api.commit(tx => operations.presented(tx, api.conversationId, operation.id, messageId), context);
    if (!recorded) fail('STALE_ACTION', 'The confirmation is no longer valid; request it again');
    return { ok: true, status: 'confirmation_required', result: { operation: action, id: note.id, message: 'Confirmation buttons sent. Wait for the user; nothing has changed yet.' } };
  }

  async function list(args: { types?: string[]; statuses?: string[]; limit?: number; cursor?: string }): Promise<Details> {
    const limit = args.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 'List limit must be 1–100');
    const memories = (await domain.list({ types: args.types, statuses: args.statuses })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const digest = createHash('sha256').update(JSON.stringify({ types: args.types?.slice().sort(), statuses: args.statuses?.slice().sort(), memories })).digest('hex');
    let offset = 0;
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string' || !/^[0-9a-f]{64}:[0-9]{1,10}$/.test(args.cursor)) fail('INVALID_INPUT', 'Invalid list cursor');
      const [expected, position] = args.cursor.split(':');
      if (expected !== digest) fail('CURSOR_CONFLICT', 'Memories or filters changed; restart listing without a cursor');
      offset = Number(position);
      if (offset > memories.length) fail('INVALID_INPUT', 'Invalid list cursor');
    }
    return { ok: true, status: 'listed', result: { memories: memories.slice(offset, offset + limit) as JsonValue, nextCursor: offset + limit < memories.length ? `${digest}:${offset + limit}` : null } };
  }

  async function read(id: string): Promise<Details> {
    const note = await domain.read(id);
    await domain.recordRead?.(note.id).catch(() => undefined);
    return { ok: true, status: 'read', result: note as JsonValue };
  }

  type Args = Static<typeof memoryOperationParameters>;
  async function run(input: unknown, api: ToolExecutionApi, context: Context): Promise<Details> {
    try {
      let args: Args;
      try {
        args = validateToolArguments({ name: 'assistant_memory', description: MEMORY_TOOL_DESCRIPTION, parameters: memoryOperationParameters },
          { type: 'toolCall', id: 'validation', name: 'assistant_memory', arguments: input as JsonObject }) as Args;
      } catch { fail('INVALID_INPUT', 'Memory arguments do not match the requested action'); }
      switch (args.action) {
        case 'read': return await read(args.id);
        case 'list': { const { action: _action, ...filters } = args; return await list(filters); }
        case 'create': return 'draft' in args ? await prepareDraft(api, context, args.draft) : await commitDraft(api, context, args.draftToken);
        case 'update': { const { action: _action, ...changes } = args; return await update(api, context, changes); }
        case 'delete': case 'share': return await requestConfirmation(api, context, args.action, args);
        default: fail('INVALID_INPUT', 'Unknown memory action');
      }
    } catch (error) {
      const failed = failure(error);
      return { ok: false, status: ['REVISION_CONFLICT', 'TEXT_CONFLICT', 'CURSOR_CONFLICT'].includes(failed.code) ? 'conflict' : 'error', error: failed };
    }
  }
  return { run, invalidate: invalidateMemoryState, decideCallback: (tx: Tx, conversationId: ConversationId, callback: AuthenticatedMemoryCallback) => decideMemoryCallback(tx, operations, conversationId, callback) };
}

/** Version 1 native tool. Bump with any schema or handler behavior change. Replay is unsafe: a mutation never reruns after a restart. */
export function createMemoryTool(options: MemoryToolOptions): NativeTool {
  const service = createMemoryToolService(options);
  return { version: 1, tool: defineTool({
    name: 'assistant_memory', description: MEMORY_TOOL_DESCRIPTION, parameters: memoryToolParameters, replay: 'unsafe',
    execute: async (args, api, context) => {
      const details = await service.run(args, api, context);
      return { output: [{ type: 'text', text: JSON.stringify(details) }], details: details as unknown as JsonValue, isError: !details.ok };
    },
  }) };
}
