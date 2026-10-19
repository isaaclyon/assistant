export interface MemoryGitMutation {
  action: "add" | "update" | "delete";
  id: string;
  relativePath: string;
  operationKey?: string;
}

export interface MemoryGitOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function prepareMemoryGitAutocommit(
  root: string,
  options?: MemoryGitOptions,
): Promise<string>;

export function commitMemoryMutation(
  root: string,
  mutation: MemoryGitMutation,
  options?: MemoryGitOptions,
): Promise<{ committed: true } | { committed: false; code: "GIT_COMMIT_FAILED" }>;

export function memoryOperationTrailer(operationKey: string): string;

export function inspectMemoryGitOperation(
  root: string,
  operation: { relativePath: string; operationKey: string },
  options?: MemoryGitOptions,
): Promise<{ committed: boolean; pathDirty: boolean; otherStaged: boolean }>;
