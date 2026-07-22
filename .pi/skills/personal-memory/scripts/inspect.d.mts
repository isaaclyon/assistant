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
  principal?: "isaac" | "emma" | "household" | "engineering";
  memoryView?: "owner-and-household" | "household" | "none";
}): Promise<CompiledCoreMemory>;
