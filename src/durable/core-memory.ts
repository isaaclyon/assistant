import { compileCoreMemory } from '../../.pi/skills/personal-memory/scripts/inspect.mjs';
import type { MemoryScope } from './recall.js';

export interface CoreMemoryText { text: string; characters: number }

/** Compiles the schema-checked core-memory notes visible to this principal (ADR-0014/0015).
 * Missing or invalid memory throws; the hook treats that as "no core memory". */
export async function compileScopedCoreMemory(scope: MemoryScope): Promise<CoreMemoryText> {
  if (scope.memoryView === 'none') return { text: '', characters: 0 };
  const principal = scope.principalId as 'isaac' | 'emma' | 'household' | 'engineering';
  const core = await compileCoreMemory({
    root: scope.vaultRoot,
    ...(scope.sessionRoots ? { sessionRoots: [...scope.sessionRoots] } : {}),
    principal,
    memoryView: scope.memoryView,
  });
  return { text: core.text, characters: core.characters };
}
