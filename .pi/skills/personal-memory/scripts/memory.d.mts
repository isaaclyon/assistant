export function executeMemoryOperation(
  command: string,
  request: Record<string, unknown>,
  options?: { env?: NodeJS.ProcessEnv; cwd?: string; confirmed?: boolean;
    /** Lint only: host-owned provenance check replacing the JSONL session loader. */
    sourceResolver?: import("./inspect.mjs").SourceResolver },
): Promise<Record<string, unknown>>;

export function runMemoryCli(options?: {
  argv?: string[]; stdin?: AsyncIterable<string | Buffer>;
  stdout?: { write(value: string): unknown }; stderr?: { write(value: string): unknown };
  env?: NodeJS.ProcessEnv; cwd?: string;
}): Promise<number>;
