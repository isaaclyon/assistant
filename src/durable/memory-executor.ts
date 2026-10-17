import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { JsonObject } from '@earendil-works/pi-durable';
import type { MemoryIntent, MemoryOperation, MemoryOperationExecutor, MemoryReconciliation, MemoryResult } from './operations.js';

/**
 * Real executor over the canonical Markdown vault (ADR-0011/0018/0048). No second
 * database: the only addition is a small per-operation receipt file under
 * `<vault>/.operations/`, written while holding the canonical mutation lock and
 * before the Markdown effect. Recovery recognizes the exact planned bytes by
 * revision; it never re-plans, so an append or create cannot be repeated and a
 * changed or missing note stays uncertain.
 *
 * Deterministic intents: call {@link prepareMemoryIntent} once, store the result in
 * `prepare()` and never recompute it on retry.
 */
export const MEMORY_EXECUTOR_NAME = 'assistant.memory.markdown';
export const MEMORY_EXECUTOR_VERSION = 1;

export type MemoryView = { principal: 'isaac' | 'emma' | 'household' | 'engineering'; memoryView: 'owner-and-household' | 'household' | 'none' };
export type MemoryExecutorHooks = {
  /** Test seams. Called while the lock is held. */
  afterReceipt?(): Promise<void> | void;
  afterMarkdown?(): Promise<void> | void;
  afterGit?(): Promise<void> | void;
};
export type MarkdownMemoryExecutorOptions = {
  /** Canonical vault root. */
  root: string;
  /** Directories that must never contain the vault (cwd/project root). */
  forbiddenRoots?: string[];
  /** Maps the operation's authenticated principal to a view. Defaults to the standard mapping. */
  resolveView?: (operation: Readonly<MemoryOperation>) => MemoryView;
  /** Optional local Git commit of the exact note path. Recorded in the receipt before the effect. */
  git?: boolean;
  env?: NodeJS.ProcessEnv;
  hooks?: MemoryExecutorHooks;
};

/** Proven pre-effect rejection. Native operation recovery may report interruption. */
export class MemoryExecutorRejected extends Error {
  readonly definitelyNotApplied = true;
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'MemoryExecutorRejected'; this.code = code; }
}

type Plan = { kind: 'create' | 'replace' | 'delete'; id: string; relativePath: string; raw?: string; preRevision: string | null; postRevision: string | null };
type Store = {
  verifyRoot(): Promise<boolean>;
  read(request: { id: string }): Promise<{ revision: string }>;
  withMutation<T>(operation: (locked: Store) => Promise<T>): Promise<T>;
  plan(command: 'add' | 'update' | 'addHappening' | 'delete', request: unknown, options?: { id?: string; timestamp?: string }): Promise<Plan> | Plan;
  apply(plan: Plan): Promise<unknown>;
};
type GitModule = {
  prepareMemoryGitAutocommit(root: string, options?: { env?: NodeJS.ProcessEnv }): Promise<string>;
  commitMemoryMutation(root: string, mutation: { action: 'add' | 'update' | 'delete'; id: string; relativePath: string; operationKey?: string }, options?: { env?: NodeJS.ProcessEnv }): Promise<{ committed: boolean }>;
  inspectMemoryGitOperation(root: string, operation: { relativePath: string; operationKey: string }, options?: { env?: NodeJS.ProcessEnv }): Promise<{ committed: boolean; pathDirty: boolean; otherStaged: boolean }>;
};
type StoreModule = { createMarkdownMemoryStore(options: { root: string; forbiddenRoots?: string[]; principal?: string; memoryView?: string; now?: () => Date; randomUUID?: () => string }): Store };
type Modules = { store: StoreModule; git: GitModule };

let loaded: Promise<Modules> | undefined;
function modules(): Promise<Modules> {
  // Build emits these assets at the same relative paths. Never walk ancestor
  // directories looking for an executable fallback outside the release.
  loaded ??= (async () => {
    const [store, git] = await Promise.all([
      import('../../.pi/skills/personal-memory/scripts/store.mjs'),
      import('../../.pi/skills/personal-memory/scripts/git.mjs'),
    ]);
    return { store: store as unknown as StoreModule, git: git as GitModule };
  })();
  return loaded;
}

export function defaultMemoryView(principal: string): MemoryView {
  if (principal === 'isaac' || principal === 'emma') return { principal, memoryView: 'owner-and-household' };
  if (principal === 'household') return { principal, memoryView: 'household' };
  if (principal === 'engineering') return { principal, memoryView: 'none' };
  throw new MemoryExecutorRejected('INVALID_PRINCIPAL', 'Unknown memory principal');
}

type Receipt = {
  version: 1; operationId: string; fingerprint: string; action: MemoryIntent['action']; noteId: string;
  relativePath: string; timestamp: string; preRevision: string | null; postRevision: string | null;
  git: boolean; effect: 'prepared' | 'applied'; gitOutcome: 'not-requested' | 'pending' | 'completed' | 'uncertain';
};
const MEMORY_FOLDERS = ['people', 'preferences', 'events', 'lists', 'recipes', 'purchases', 'references'];
/** Operation IDs must be globally unique within one vault: the receipt file and Git trailer are keyed by this hash alone. */
const operationKey = (id: string) => createHash('sha256').update(id).digest('hex');
const receiptText = (receipt: Receipt) => `memory-operation:${operationKey(receipt.operationId)}:${receipt.postRevision ?? 'deleted'}`;

type Command = { command: 'add' | 'update' | 'addHappening' | 'delete'; request: Record<string, unknown> };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryExecutorRejected('INVALID_INTENT', 'Memory intent payload is invalid');
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new MemoryExecutorRejected('INVALID_INTENT', 'Memory intent payload is invalid');
}
/** Single mapping from typed intent to the canonical store command. */
function commandFor(intent: MemoryIntent): Command {
  const payload = object(intent.payload);
  const id = intent.noteId;
  const pre = intent.preRevision ?? undefined;
  switch (intent.action) {
    case 'create': only(payload, ['request']); return { command: 'add', request: object(payload.request) };
    case 'update': {
      only(payload, ['patch']); const patch = object(payload.patch);
      if (patch.scope === 'household') throw new MemoryExecutorRejected('INVALID_INTENT', 'Sharing must use the share action');
      return { command: 'update', request: { id, ifRevision: pre, patch } };
    }
    case 'append': {
      only(payload, ['append', 'happening']);
      if (payload.happening !== undefined) { only(payload, ['happening']); return { command: 'addHappening', request: { id, ifRevision: pre, ...object(payload.happening) } }; }
      only(payload, ['append']); return { command: 'update', request: { id, ifRevision: pre, patch: { append: payload.append } } };
    }
    case 'share': {
      only(payload, ['patch']); const patch = object(payload.patch);
      if (Object.keys(patch).length !== 1 || patch.scope !== 'household') throw new MemoryExecutorRejected('INVALID_INTENT', 'Share must set only household scope');
      return { command: 'update', request: { id, ifRevision: pre, patch } };
    }
    case 'delete': only(payload, []); return { command: 'delete', request: { id, ifRevision: pre, confirmId: id } };
    default: throw new MemoryExecutorRejected('INVALID_INTENT', 'Unknown memory action');
  }
}
function validateShape(intent: MemoryIntent) {
  const create = intent.action === 'create'; const remove = intent.action === 'delete';
  if ((create && intent.preRevision !== null) || (!create && !intent.preRevision) || (remove && intent.postRevision !== null) || (!remove && !intent.postRevision) ||
    Number.isNaN(Date.parse(intent.timestamp)) || new Date(intent.timestamp).toISOString() !== intent.timestamp)
    throw new MemoryExecutorRejected('INVALID_INTENT', 'Memory intent needs deterministic note id, timestamp and revisions');
}

async function writeDurable(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  const dir = await open(dirname(path), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

export function createMarkdownMemoryExecutor(options: MarkdownMemoryExecutorOptions): MemoryOperationExecutor {
  const root = resolve(options.root);
  const env = options.env ?? process.env;
  const hooks = options.hooks ?? {};
  const receiptDirectory = join(root, '.operations');
  const viewFor = options.resolveView ?? ((operation: Readonly<MemoryOperation>) => defaultMemoryView(operation.binding.principal));

  async function createStore(operation: Readonly<MemoryOperation>, extra: { now?: () => Date } = {}) {
    const mod = await modules();
    const view = viewFor(operation);
    return mod.store.createMarkdownMemoryStore({ root, forbiddenRoots: options.forbiddenRoots, principal: view.principal, memoryView: view.memoryView, ...extra });
  }
  const receiptPath = (id: string) => join(receiptDirectory, `${operationKey(id)}.json`);
  async function readReceipt(operation: Readonly<MemoryOperation>): Promise<Receipt | null> {
    const path = receiptPath(operation.id);
    let text: string;
    try {
      const dir = await lstat(receiptDirectory);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe memory receipt directory');
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Unsafe memory receipt file');
      text = await readFile(path, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let value: Receipt;
    try { value = JSON.parse(text) as Receipt; } catch { throw new Error('Memory receipt is unreadable'); }
    const intent = operation.intent;
    if (!value || typeof value !== 'object' || value.version !== 1 || value.operationId !== operation.id || value.fingerprint !== operation.fingerprint || value.noteId !== intent.noteId || value.action !== intent.action ||
      value.preRevision !== intent.preRevision || value.postRevision !== intent.postRevision || value.timestamp !== intent.timestamp) throw new Error('Memory receipt does not match operation');
    if (typeof value.relativePath !== 'string' || !MEMORY_FOLDERS.some(folder => value.relativePath === `${folder}/${intent.noteId}.md`) ||
      typeof value.git !== 'boolean' || (value.effect !== 'prepared' && value.effect !== 'applied') ||
      !['not-requested', 'pending', 'completed', 'uncertain'].includes(value.gitOutcome) ||
      (value.git ? value.gitOutcome === 'not-requested' : value.gitOutcome !== 'not-requested'))
      throw new Error('Memory receipt is malformed');
    return value;
  }
  async function saveReceipt(receipt: Receipt) {
    const existed = await lstat(receiptDirectory).then(() => true, () => false);
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    if (!existed) { const rootDir = await open(root, 'r'); try { await rootDir.sync(); } finally { await rootDir.close(); } }
    const info = await lstat(receiptDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe memory receipt directory');
    await chmod(receiptDirectory, 0o700);
    await writeDurable(receiptPath(receipt.operationId), `${JSON.stringify(receipt)}\n`);
  }
  async function currentRevision(receipt: Receipt): Promise<string | 'absent' | 'unreadable'> {
    try {
      if (receipt.postRevision === null) {
        // A deleted note must be absent from every type folder, so a tampered folder cannot fake success.
        for (const folder of MEMORY_FOLDERS) {
          const other = join(root, folder, `${receipt.noteId}.md`);
          if (other !== join(root, receipt.relativePath) && await lstat(other).then(() => true, () => false)) return 'unreadable';
        }
      }
      const raw = await readFile(join(root, receipt.relativePath), 'utf8');
      return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'; }
  }
  const gitAction = (action: MemoryIntent['action']): 'add' | 'update' | 'delete' => action === 'create' ? 'add' : action === 'delete' ? 'delete' : 'update';

  /** Completes or recognizes the Git commit for exactly one note path. Never touches Markdown. */
  async function settleGit(receipt: Receipt): Promise<Receipt['gitOutcome']> {
    if (!receipt.git) return 'not-requested';
    if (receipt.gitOutcome === 'completed') return 'completed';
    const { git } = await modules();
    const key = operationKey(receipt.operationId);
    try {
      let state = await git.inspectMemoryGitOperation(root, { relativePath: receipt.relativePath, operationKey: key }, { env });
      if (state.committed) return 'completed';
      if (state.otherStaged || !state.pathDirty) return 'uncertain';
      const committed = await git.commitMemoryMutation(root, { action: gitAction(receipt.action), id: receipt.noteId, relativePath: receipt.relativePath, operationKey: key }, { env });
      if (committed.committed) return 'completed';
      state = await git.inspectMemoryGitOperation(root, { relativePath: receipt.relativePath, operationKey: key }, { env });
      return state.committed ? 'completed' : 'uncertain';
    } catch { return 'uncertain'; }
  }
  async function finish(receipt: Receipt): Promise<MemoryResult> {
    const outcome = await settleGit(receipt);
    if (outcome !== receipt.gitOutcome || receipt.effect !== 'applied') {
      try { await saveReceipt({ ...receipt, effect: 'applied', gitOutcome: outcome }); } catch { /* the Markdown receipt is authoritative; Git can be re-detected */ }
    }
    return { revision: receipt.postRevision, receipt: receiptText(receipt), git: outcome === 'completed' ? 'completed' : outcome === 'not-requested' ? 'not-requested' : 'uncertain' };
  }
  /** Recognizes the exact planned bytes. Anything else stays uncertain. */
  async function recognize(receipt: Receipt): Promise<MemoryReconciliation> {
    const revision = await currentRevision(receipt);
    const applied = receipt.postRevision === null ? revision === 'absent' : revision === receipt.postRevision;
    if (applied) return { status: 'succeeded', result: await finish(receipt) };
    if (revision === receipt.preRevision) return { status: 'unknown', reason: 'Receipt exists but Markdown still has the pre-effect revision; no effect recognized' };
    return { status: 'unknown', reason: 'Note does not match the intended result; inspect before trusting' };
  }

  return {
    name: MEMORY_EXECUTOR_NAME,
    version: MEMORY_EXECUTOR_VERSION,
    async execute(operation, control) {
      validateShape(operation.intent);
      const { command, request } = commandFor(operation.intent);
      if (operation.approval.decision?.choice !== 'approve' || ((operation.intent.action === 'delete' || operation.intent.action === 'share') && !operation.approval.presentation))
        throw new MemoryExecutorRejected('NOT_APPROVED', 'Operation is not approved');
      const intent = operation.intent;
      // Failures before the lock callback runs are proven pre-effect.
      let entered = false;
      try {
      const store = await createStore(operation, { now: () => new Date(intent.timestamp) });
      const mod = await modules();
      return await store.withMutation(async (locked: Store) => {
        entered = true;
        const existing = await readReceipt(operation);
        if (existing) {
          // A previous attempt already crossed the effect boundary. Never plan again.
          const settled = await recognize(existing);
          if (settled.status === 'succeeded') return settled.result;
          throw new Error(settled.reason);
        }
        let plan: Plan;
        try {
          if (options.git) await mod.git.prepareMemoryGitAutocommit(root, { env });
          await control.assertAuthority();
          control.signal.throwIfAborted();
          plan = await locked.plan(command, request, { id: intent.noteId, timestamp: intent.timestamp });
          if (plan.id !== intent.noteId || plan.preRevision !== intent.preRevision || plan.postRevision !== intent.postRevision)
            throw new MemoryExecutorRejected('INTENT_MISMATCH', 'Planned note does not match the intended revisions');
        } catch (error) {
          if (error instanceof MemoryExecutorRejected) throw error;
          throw new MemoryExecutorRejected('PRE_EFFECT_REJECTED', 'Memory request rejected before its effect');
        }
        const receipt: Receipt = { version: 1, operationId: operation.id, fingerprint: operation.fingerprint, action: intent.action, noteId: intent.noteId,
          relativePath: plan.relativePath, timestamp: intent.timestamp, preRevision: intent.preRevision, postRevision: intent.postRevision,
          git: options.git === true, effect: 'prepared', gitOutcome: options.git ? 'pending' : 'not-requested' };
        await saveReceipt(receipt);
        await hooks.afterReceipt?.();
        await locked.apply(plan);
        await hooks.afterMarkdown?.();
        const result = await finish(receipt);
        await hooks.afterGit?.();
        return result;
      });
      } catch (error) {
        if (entered || error instanceof MemoryExecutorRejected) throw error;
        throw new MemoryExecutorRejected('PRE_EFFECT_REJECTED', 'Memory store unavailable before its effect');
      }
    },
    async reconcile(operation) {
      try {
        validateShape(operation.intent);
        if (!await (await createStore(operation)).verifyRoot()) return { status: 'unknown', reason: 'Memory vault is unavailable' };
        const store = await createStore(operation);
        return await store.withMutation(async (locked: Store) => {
          const receipt = await readReceipt(operation);
          if (!receipt) return { status: 'unknown', reason: 'No memory receipt; not safe to infer or repeat the effect' } as const;
          return recognize(receipt);
        });
      } catch (error) {
        return { status: 'unknown', reason: error instanceof Error ? error.message : 'Memory reconciliation failed' };
      }
    },
  };
}

export type PrepareMemoryIntentInput =
  | { action: 'create'; request: JsonObject; noteId?: string; timestamp?: string }
  | { action: 'update' | 'share'; noteId: string; patch: JsonObject; timestamp?: string }
  | { action: 'append'; noteId: string; append: string; timestamp?: string }
  | { action: 'append'; noteId: string; happening: { date: string; text: string }; timestamp?: string }
  | { action: 'delete'; noteId: string; timestamp?: string };

/**
 * Builds the deterministic intent persisted by MemoryOperations.prepare(): fixed note
 * id and timestamp, the current note revision, and the exact resulting revision. It
 * reads the vault without effect. Reuse the returned intent unchanged on every retry.
 */
export async function prepareMemoryIntent(options: { root: string; forbiddenRoots?: string[]; view: MemoryView; now?: () => Date },
  input: PrepareMemoryIntentInput): Promise<{ intent: MemoryIntent; relativePath: string }> {
  const mod = await modules();
  const timestamp = input.timestamp ?? (options.now ?? (() => new Date()))().toISOString();
  const store = mod.store.createMarkdownMemoryStore({ root: options.root, forbiddenRoots: options.forbiddenRoots, principal: options.view.principal, memoryView: options.view.memoryView });
  const noteId = input.action === 'create' ? input.noteId ?? randomUUID() : input.noteId;
  let intent: MemoryIntent;
  let plan: Plan;
  if (input.action === 'create') {
    intent = { action: 'create', noteId, timestamp, preRevision: null, postRevision: null, payload: { request: input.request } };
    plan = await store.plan('add', input.request, { id: noteId, timestamp });
  } else {
    const current = await store.read({ id: noteId });
    const base = { noteId, timestamp, preRevision: current.revision, postRevision: null };
    if (input.action === 'delete') { intent = { ...base, action: 'delete', payload: {} }; }
    else if (input.action === 'append') intent = { ...base, action: 'append', payload: 'happening' in input ? { happening: input.happening } : { append: input.append } };
    else intent = { ...base, action: input.action, payload: { patch: input.patch } };
    const { command, request } = commandFor(intent);
    plan = await store.plan(command, request, { id: noteId, timestamp });
  }
  return { intent: { ...intent, postRevision: plan.postRevision }, relativePath: plan.relativePath };
}
