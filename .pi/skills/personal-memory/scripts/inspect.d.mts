export interface CompiledCoreMemory {
  text: string;
  characters: number;
  budget: number;
  warning: boolean;
  contributors: Array<{ id: string; characters: number }>;
}

export function compileCoreMemory(options: {
  root: string;
  forbiddenRoots?: string[];
  sessionRoot?: string;
  sessionRoots?: string[];
  sourceResolver?: SourceResolver;
  principal?: "isaac" | "emma" | "household" | "engineering";
  memoryView?: "owner-and-household" | "household" | "none";
}): Promise<CompiledCoreMemory>;

export type SourceAnchor = { sessionId: string; entryId: string; timestamp: string };
export type SourceFindingCode =
  | "SOURCE_SESSION_NOT_FOUND"
  | "SOURCE_SESSION_INVALID"
  | "SOURCE_SESSION_SCAN_LIMIT_EXCEEDED"
  | "SOURCE_ENTRY_NOT_FOUND"
  | "SOURCE_TIMESTAMP_MISMATCH";
/** Host-owned provenance check; returns one finding code (or null when it resolves) per anchor, in order. */
export type SourceResolver = (
  anchors: SourceAnchor[],
  limits: { maxBytes: number; maxEntries: number },
) => Promise<Array<SourceFindingCode | null>>;

export function lintMemoryVault(options: {
  root: string;
  forbiddenRoots?: string[];
  sessionRoot?: string;
  sessionRoots?: string[];
  sourceResolver?: SourceResolver;
  principal?: "isaac" | "emma" | "household" | "engineering";
  memoryView?: "owner-and-household" | "household" | "none";
}): Promise<unknown>;
