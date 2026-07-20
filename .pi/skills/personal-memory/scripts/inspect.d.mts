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
}): Promise<CompiledCoreMemory>;
