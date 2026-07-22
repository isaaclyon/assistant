export function resolveMemoryDirectory(
  env?: NodeJS.ProcessEnv,
  home?: string,
): string;

export function resolveBridgeSessionDirectory(
  env?: NodeJS.ProcessEnv,
  home?: string,
): string;

export function resolveMemoryGitAutocommit(env?: NodeJS.ProcessEnv): boolean;

export function resolveMemoryView(env?: NodeJS.ProcessEnv): {
  principal: "isaac" | "emma" | "household" | "engineering";
  memoryView: "owner-and-household" | "household" | "none";
};

export function resolveBridgeSessionDirectories(
  env?: NodeJS.ProcessEnv,
  home?: string,
): string[];
