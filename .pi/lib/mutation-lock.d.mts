export class MutationBusyError extends Error {
  code: "MUTATION_BUSY";
}
export function withMutationLock<T>(
  path: string,
  operation: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T>;
