import { executeMemoryOperation } from '../../.pi/skills/personal-memory/scripts/memory.mjs';
// store.mjs has no declaration file yet; @ts-ignore stays valid once one is added.
// @ts-ignore TS7016
import * as canonicalStore from '../../.pi/skills/personal-memory/scripts/store.mjs';
import { resolveMemoryView } from '../../.pi/skills/personal-memory/scripts/config.mjs';

export type MemoryDecay = 'durable' | 'fading';
export type MemoryDraft = { type: string; title: string; tags?: string[]; body: string; decay?: MemoryDecay };
export type MemoryPatch = {
  title?: string; tags?: string[]; status?: string; decay?: MemoryDecay | null; append?: string;
  bodyEdits?: Array<{ expectedText: string; replacementText: string }>;
};
export type MemoryNote = { id: string; revision: string; scope: string; title: string; type: string; updated: string; [key: string]: unknown };
export type DuplicatePage = { results: unknown[]; retrieval?: unknown };
export const MemoryError = (canonicalStore as unknown as { MemoryError: new (code: string, message: string) => Error & { code: string } }).MemoryError;
const validateMemoryDraft = (canonicalStore as unknown as { validateMemoryDraft(raw: unknown): MemoryDraft }).validateMemoryDraft;

/** Read-side domain services. Mutations never pass through here; they run in the durable executor. */
export interface MemoryDomain {
  /** Throws MemoryError INVALID_INPUT for an unusable draft. */
  validateDraft(raw: unknown): MemoryDraft;
  read(id: string): Promise<MemoryNote>;
  list(filters: { types?: string[]; statuses?: string[] }): Promise<Array<Record<string, unknown>>>;
  /** Up to five related notes visible to the current principal. */
  findDuplicates(draft: MemoryDraft): Promise<DuplicatePage>;
  /** Ranking usage signal (ADR-0045). A failure never fails the read. */
  recordRead?(id: string): Promise<void>;
}

export function assertMemoryAvailable(env: NodeJS.ProcessEnv): void {
  try {
    if (!env.PI_TELEGRAM_PRINCIPAL || !env.PI_TELEGRAM_MEMORY_VIEW || resolveMemoryView(env).memoryView === 'none') throw new Error('unavailable');
  } catch { throw new MemoryError('UNAVAILABLE', 'Memory tools require a configured personal or household instance'); }
}

/** Canonical Markdown domain over the shared store. The host supplies `env` (see nativeMemoryEnvironment). */
export function createCanonicalMemoryDomain(options: {
  env: NodeJS.ProcessEnv; cwd?: string;
  /** Hybrid search supplied by the search component; the default is keyword search over the vault. */
  findDuplicates?: (draft: MemoryDraft) => Promise<DuplicatePage>;
  recordRead?: (id: string) => Promise<void>;
}): MemoryDomain {
  const env = { ...options.env };
  const cwd = options.cwd ?? process.cwd();
  assertMemoryAvailable(env);
  const run = (command: string, request: Record<string, unknown>) => executeMemoryOperation(command, request, { env, cwd });
  return {
    validateDraft(raw) {
      if (!raw || typeof raw !== 'object' || Object.keys(raw).some(key => !['type', 'title', 'tags', 'body', 'decay'].includes(key))) {
        throw new MemoryError('INVALID_INPUT', 'Memory draft is invalid');
      }
      return validateMemoryDraft(raw) as MemoryDraft;
    },
    async read(id) { return await run('read', { id }) as MemoryNote; },
    async list(filters) { return (await run('list', filters) as { memories: Array<Record<string, unknown>> }).memories; },
    async findDuplicates(draft) {
      if (options.findDuplicates) return options.findDuplicates(draft);
      const found = await run('search', { query: `${draft.title}\n${draft.body}`.slice(0, 512), limit: 5 }) as { results: unknown[] };
      return { results: found.results, retrieval: { mode: 'keyword' } };
    },
    ...(options.recordRead ? { recordRead: options.recordRead } : {}),
  };
}
