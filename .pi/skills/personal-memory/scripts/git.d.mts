export interface MemoryGitMutation {
  action: "add" | "update" | "delete";
  id: string;
  relativePath: string;
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
