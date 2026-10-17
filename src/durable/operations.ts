import { createHash, randomBytes } from 'node:crypto';
import { defineDoc, defineTask, type ConversationId, type JsonObject, type TaskId, type Tx } from '@earendil-works/pi-durable';

/** Ordinary memory authority only. Credential decisions remain owned by the broker. */
export type MemoryIntent = {
  action: 'create' | 'update' | 'append' | 'delete' | 'share';
  noteId: string;
  timestamp: string;
  preRevision: string | null;
  postRevision: string | null;
  payload: JsonObject;
};
export type MemoryBinding = {
  principal: string;
  target: { chatId: string; threadId: string | null };
  epoch: string;
};
export type MemoryResult = { revision: string | null; receipt: string; git: 'not-requested' | 'completed' | 'uncertain' };
export type MemoryOperation = {
  version: number;
  id: string;
  fingerprint: string;
  handler: { name: string; version: number };
  binding: MemoryBinding;
  intent: MemoryIntent;
  expiresAt: number;
  status: 'prepared' | 'authorized' | 'executing' | 'succeeded' | 'interrupted' | 'uncertain' | 'blocked';
  approval: {
    token: string;
    presentation: { messageId: string; at: number } | null;
    decision: { principal: string; at: number; choice: 'approve' | 'deny' } | null;
    invalidated: string | null;
  };
  taskId: TaskId<MemoryOperationOutcome> | null;
  result: MemoryResult | null;
  reason: string | null;
};
export type MemoryOperationOutcome = { operationId: string; status: MemoryOperation['status']; reason: string | null;
  /** Persisted saved-note and Git details, copied from the operation record. */
  result: MemoryResult | null };
export type MemoryOperationState = { version: number; epoch: string | null; operations: MemoryOperation[] };
export const MemoryOperations = defineDoc<MemoryOperationState>({
  kind: 'assistant.memory-operations', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ version: 1, epoch: null, operations: [] }),
});

export type MemoryReconciliation =
  | { status: 'succeeded'; result: MemoryResult }
  | { status: 'unknown'; reason: string };
type Settled = MemoryReconciliation | { status: 'interrupted'; reason: string };
/** C3 must hold the canonical mutation lock through authority/revision checks and
 * Markdown replacement. Persist an operation receipt alongside the domain effect.
 * Reconcile is read-only: an absent receipt is NOT permission to repeat an append.
 * Git completion is a distinct result; uncertain Git must never repeat Markdown. */
export interface MemoryOperationExecutor {
  readonly name: string;
  readonly version: number;
  execute(operation: Readonly<MemoryOperation>, control: { signal: AbortSignal; assertAuthority(): Promise<void> }): Promise<MemoryResult>;
  reconcile(operation: Readonly<MemoryOperation>, control: { signal: AbortSignal }): Promise<MemoryReconciliation>;
}
export interface MemoryOperationAuthority {
  /** Called inside a native commit; use tx for native reads. Never call Harness reads here.
   * Check selected capability, current principal/target and current revision for execute;
   * for reconcile, permit inspection of this operation's own post-effect receipt. */
  check(operation: Readonly<MemoryOperation>, mode: 'approve' | 'execute' | 'reconcile', tx: Tx): Promise<boolean>;
}
export type AuthenticatedMemoryCallback = {
  token: string;
  /** Obtained from trusted ingress, never from callback data or model arguments. */
  principal: string;
  target: MemoryBinding['target'];
  messageId: string;
  choice: 'approve' | 'deny';
};
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Non-JSON operation');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
/** Callers must supply the same stable original expiresAt on every retry of an
 * operation id: it is part of the fingerprint, so a recomputed expiry conflicts. */
export function memoryOperationFingerprint(value: Pick<MemoryOperation, 'binding' | 'intent' | 'handler' | 'expiresAt'>): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function validRecord(op: MemoryOperation): boolean {
  return op.version === 1 && op.fingerprint === memoryOperationFingerprint({ binding: op.binding, intent: op.intent, handler: op.handler, expiresAt: op.expiresAt });
}
function needsConfirmation(op: MemoryOperation): boolean { return op.intent.action === 'delete' || op.intent.action === 'share'; }
function outcome(op: MemoryOperation): MemoryOperationOutcome { return { operationId: op.id, status: op.status, reason: op.reason, result: op.result ? copy(op.result) : null }; }
function terminal(op: MemoryOperation) { return { status: 'terminal' as const, outcome: { status: 'completed' as const, result: outcome(op) } }; }
function find(state: MemoryOperationState, id: string): MemoryOperation {
  if (state.version !== 1) throw new Error('Unsupported memory operation document version');
  const op = state.operations.find(item => item.id === id);
  if (!op) throw new Error(`Missing memory operation: ${id}`);
  return op;
}

export function createMemoryOperations(options: { authority: MemoryOperationAuthority; executor?: MemoryOperationExecutor; now?: () => number }) {
  const now = options.now ?? Date.now;
  const executor = options.executor;
  function compatible(op: MemoryOperation) { return executor && op.handler.name === executor.name && op.handler.version === executor.version; }
  const task = defineTask<{ operationId: string }, { phase: 'run' }, MemoryOperationOutcome>({
    name: 'assistant.memory-operation', version: 1, initial: () => ({ phase: 'run' }),
    phases: { run: async (running, runtime, context) => {
      let operation: MemoryOperation | undefined;
      let recover = false;
      await runtime.commit(async tx => {
        const state = await tx.doc(MemoryOperations, runtime.conversationId);
        const op = find(state, running.input.operationId);
        if (op.status === 'succeeded' || op.status === 'uncertain' || op.status === 'interrupted' || op.status === 'blocked') return terminal(op);
        recover = op.status === 'executing';
        if (!validRecord(op) || !compatible(op)) {
          if (recover) {
            // The effect may have happened. Do not report a pre-effect block.
            op.status = 'uncertain';
            op.reason = `External outcome uncertain: effect was executing and no matching executor ${op.handler.name}@${op.handler.version} is installed; reconcile manually with a matching executor`;
          } else { op.status = 'blocked'; op.reason = 'Missing or incompatible memory executor/record'; }
          return terminal(op);
        }
        if (op.taskId !== runtime.taskId || op.approval.decision?.choice !== 'approve' || (needsConfirmation(op) && !op.approval.presentation) || op.approval.invalidated ||
          (!recover && (state.epoch !== op.binding.epoch || now() >= op.expiresAt)) ||
          !await options.authority.check(op, recover ? 'reconcile' : 'execute', tx)) {
          op.status = recover ? 'uncertain' : 'interrupted'; op.reason = 'Current memory authority rejected'; return terminal(op);
        }
        op.status = 'executing';
        operation = copy(op);
      }, context);
      if (!operation || !executor) return;
      const selected = operation;
      const assertAuthority = async () => {
        await runtime.commit(async tx => {
          const state = await tx.doc(MemoryOperations, runtime.conversationId);
          const op = find(state, selected.id);
          if (op.status !== 'executing' || op.taskId !== runtime.taskId || state.epoch !== op.binding.epoch || now() >= op.expiresAt ||
            !validRecord(op) || !await options.authority.check(op, 'execute', tx)) throw new Error('Memory authority changed before effect');
          return undefined;
        }, context);
      };
      let result: Settled = { status: 'unknown', reason: 'Executor outcome not recorded' };
      try {
        if (recover) result = await executor.reconcile(selected, { signal: runtime.signal });
        else {
          let invoked = false;
          try { await assertAuthority(); invoked = true; } catch { result = { status: 'interrupted', reason: 'Memory authority changed before effect' }; }
          if (invoked) result = { status: 'succeeded', result: await executor.execute(selected, { signal: runtime.signal, assertAuthority }) };
        }
      } catch {
        // A thrown executor may have replaced Markdown. Never infer failure/no effect.
        result = { status: 'unknown', reason: 'Executor interrupted; domain outcome requires inspection' };
      }
      await runtime.commit(async tx => {
        const op = find(await tx.doc(MemoryOperations, runtime.conversationId), selected.id);
        if (op.status !== 'executing') return terminal(op);
        if (result.status === 'succeeded') {
          op.result = result.result;
          const expected = op.intent.postRevision;
          if (expected !== null && result.result.revision !== expected) { op.status = 'uncertain'; op.reason = 'Result revision does not match intended revision; inspect before trusting'; }
          else if (result.result.git === 'uncertain') { op.status = 'uncertain'; op.reason = 'Markdown completed; Git outcome uncertain'; }
          else { op.status = 'succeeded'; op.reason = null; }
        } else if (result.status === 'interrupted') { op.status = 'interrupted'; op.reason = result.reason; }
        else { op.status = 'uncertain'; op.reason = result.reason; }
        return terminal(op);
      }, context);
    } },
    abort: async (running, runtime, context) => {
      await runtime.commit(async tx => {
        const op = find(await tx.doc(MemoryOperations, runtime.conversationId), running.input.operationId);
        if (op.status === 'executing') { op.status = 'uncertain'; op.reason = 'Native task aborted during effect; outcome uncertain'; }
        else if (op.status === 'prepared' || op.status === 'authorized') { op.status = 'interrupted'; op.reason = 'Native task aborted'; }
        return terminal(op);
      }, context);
    },
  });
  return {
    task,
    /** Trusted application preparation. C3 keeps this token out of model tool results. */
    async prepare(tx: Tx, conversationId: ConversationId, input: { id: string; binding: MemoryBinding; intent: MemoryIntent; handler: MemoryOperation['handler']; expiresAt: number }): Promise<MemoryOperation> {
      const state = await tx.doc(MemoryOperations, conversationId);
      if (state.version !== 1) throw new Error('Unsupported memory operation document version');
      if (!input.id || !input.binding.principal || !input.binding.epoch || !input.binding.target.chatId || !input.intent.noteId || !Number.isFinite(input.expiresAt) || input.expiresAt <= now() || input.expiresAt > now() + 600_000) throw new Error('Invalid memory operation binding or expiry');
      const fingerprint = memoryOperationFingerprint({ binding: input.binding, intent: input.intent, handler: input.handler, expiresAt: input.expiresAt });
      const existing = state.operations.find(op => op.id === input.id);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('Memory operation identity conflict'); return copy(existing); }
      if (state.epoch !== null && state.epoch !== input.binding.epoch) throw new Error('Memory conversation epoch mismatch');
      state.epoch = input.binding.epoch;
      const op: MemoryOperation = { ...copy(input), version: 1, fingerprint, status: 'prepared', approval: { token: randomBytes(32).toString('hex'), presentation: null, decision: null, invalidated: null }, taskId: null, result: null, reason: null };
      state.operations.push(op);
      return copy(op);
    },
    /** Trusted tool application path for create/update/append. The authority service
     * must verify the current user request and scope; model arguments alone confer
     * no authority. Share/delete always require the authenticated callback path. */
    async authorize(tx: Tx, conversationId: ConversationId, id: string): Promise<{ accepted: false } | { accepted: true; taskId: TaskId<MemoryOperationOutcome> }> {
      const state = await tx.doc(MemoryOperations, conversationId); const op = find(state, id);
      if (needsConfirmation(op) || !validRecord(op) || !compatible(op) || op.status !== 'prepared' || op.approval.decision || op.approval.invalidated ||
        state.epoch !== op.binding.epoch || now() >= op.expiresAt || !await options.authority.check(op, 'approve', tx)) return { accepted: false };
      op.approval.decision = { principal: op.binding.principal, at: now(), choice: 'approve' };
      op.status = 'authorized';
      op.taskId = await tx.createTask(task, { operationId: op.id }, { ownership: { kind: 'conversation' }, conversationId });
      return { accepted: true, taskId: op.taskId };
    },
    async presented(tx: Tx, conversationId: ConversationId, id: string, messageId: string): Promise<boolean> {
      const state = await tx.doc(MemoryOperations, conversationId); const op = find(state, id);
      if (!messageId || op.status !== 'prepared' || op.approval.invalidated || op.approval.presentation || state.epoch !== op.binding.epoch || now() >= op.expiresAt) return false;
      op.approval.presentation = { messageId, at: now() }; return true;
    },
    async presentationFailed(tx: Tx, conversationId: ConversationId, id: string): Promise<void> {
      const op = find(await tx.doc(MemoryOperations, conversationId), id);
      if (op.status === 'prepared') { op.approval.invalidated = 'presentation-failed'; op.status = 'interrupted'; op.reason = 'Confirmation presentation failed'; }
    },
    async decide(tx: Tx, conversationId: ConversationId, callback: AuthenticatedMemoryCallback): Promise<{ accepted: false } | { accepted: true; taskId: TaskId<MemoryOperationOutcome> | null }> {
      const state = await tx.doc(MemoryOperations, conversationId);
      if (state.version !== 1) return { accepted: false };
      const op = state.operations.find(item => item.approval.token === callback.token);
      if (!op || !validRecord(op) || !compatible(op) || op.status !== 'prepared' || op.approval.decision || op.approval.invalidated ||
        op.approval.presentation?.messageId !== callback.messageId || op.binding.principal !== callback.principal ||
        op.binding.target.chatId !== callback.target.chatId || op.binding.target.threadId !== callback.target.threadId ||
        state.epoch !== op.binding.epoch || now() >= op.expiresAt || !await options.authority.check(op, 'approve', tx)) return { accepted: false };
      op.approval.decision = { principal: callback.principal, at: now(), choice: callback.choice };
      if (callback.choice === 'deny') { op.status = 'interrupted'; op.reason = 'User denied'; return { accepted: true, taskId: null }; }
      op.status = 'authorized';
      op.taskId = await tx.createTask(task, { operationId: op.id }, { ownership: { kind: 'conversation' }, conversationId });
      return { accepted: true, taskId: op.taskId };
    },
    /** Restart does not call invalidate. Explicit new/reload/reset do. In-flight
     * consumed effects retain their receipt identity and can only reconcile. */
    async invalidate(tx: Tx, conversationId: ConversationId, nextEpoch: string, reason: 'new' | 'reload' | 'reset'): Promise<void> {
      const state = await tx.doc(MemoryOperations, conversationId);
      if (!nextEpoch || nextEpoch === state.epoch) throw new Error('Invalidation requires a fresh epoch');
      state.epoch = nextEpoch;
      for (const op of state.operations) if (op.status === 'prepared') { op.approval.invalidated = reason; op.status = 'interrupted'; op.reason = reason; }
    },
    inspect(state: Readonly<MemoryOperationState>) {
      return state.operations.map(op => ({ id: op.id, taskId: op.taskId, status: op.status,
        blocked: state.version !== 1 || !validRecord(op) || !compatible(op),
        reason: state.version !== 1 || !validRecord(op) ? 'Incompatible memory record; inspect before upgrade' : !compatible(op) ? `Install memory executor ${op.handler.name}@${op.handler.version}${op.status === 'uncertain' ? ' and reconcile manually; external outcome is uncertain' : ''}` : op.reason,
      }));
    },
  };
}
