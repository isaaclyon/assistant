import type { MemoryScanStore } from "./memory-scan-store.js";

export interface SearchIndexStatus {
  schemaVersion: number;
  memoryDocuments: number;
  sessionDocuments: number;
}

export type SearchCorpus = "memory" | "session";

export interface CorpusOperationStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}

export interface SearchIndex {
  memoryScan: MemoryScanStore;
  withRefreshLock<T>(corpus: SearchCorpus, operation: () => Promise<T>): Promise<T>;
  sessionScanCursor(instanceId: string, principalId: string): string | undefined;
  setSessionScanCursor(instanceId: string, principalId: string, path: string): void;
  sessionContextStart(instanceId: string, principalId: string, path: string, targetOffset: number, before: number): { offset: number; hasMoreBefore: boolean };
  status(): SearchIndexStatus;
  replaceMemoryDocuments(documents: MemoryIndexDocument[]): void;
  searchMemory(query: string, limit: number): MemorySearchPage;
  searchMemoryDocuments(request: MemoryDocumentSearchRequest): MemoryDocumentSearchPage;
  replaceSessionDocuments(documents: SessionIndexDocument[]): void;
  replaceSessionCorpus(
    instanceId: string,
    principalId: string,
    states: SessionSourceState[],
    documents: SessionIndexDocument[],
  ): void;
  searchSessions(query: string, limit: number): SessionSearchPage;
  searchSessionDocuments(request: SessionDocumentSearchRequest): SessionDocumentSearchPage;
  getSessionSourceState(
    instanceId: string,
    principalId: string,
    sourcePath: string,
  ): SessionSourceState | undefined;
  listSessionSourceStates(instanceId: string, principalId: string): SessionSourceState[];
  getSessionEntryIds(instanceId: string, principalId: string, sourcePath: string, beforeOffset?: number): Set<string>;
  getSessionDocument(
    instanceId: string,
    principalId: string,
    sessionId: string,
    entryId: string,
  ): SessionIndexDocument | undefined;
  replaceSessionSource(state: SessionSourceState, documents: SessionIndexDocument[], seenEntries?: SessionSeenEntry[]): void;
  appendSessionSource(state: SessionSourceState, documents: SessionIndexDocument[], seenEntries?: SessionSeenEntry[]): void;
  deleteSessionSource(instanceId: string, principalId: string, sourcePath: string): void;
  recordCorpusAttempt(corpus: SearchCorpus, timestamp: string): void;
  recordCorpusSuccess(corpus: SearchCorpus, timestamp: string): void;
  corpusStatuses(): Record<SearchCorpus, CorpusOperationStatus>;
  close(): void;
}

export interface MemoryIndexDocument {
  noteId: string;
  relativePath: string;
  revision: string;
  title: string;
  tags: string[];
  body: string;
  type: string;
  status: string;
  scope: string;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryIndexMatch {
  noteId: string;
  score: number;
  snippet: string;
}

export interface MemoryDocumentSearchRequest {
  query: string;
  limit: number;
  principal: string;
  memoryView: "owner-and-household" | "household" | "none";
  types?: string[];
  statuses?: string[];
}

export interface MemoryDocumentSearchMatch {
  source: "memory";
  schema: number;
  id: string;
  relativePath: string;
  type: string;
  status: string;
  scope: string;
  owner?: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  revision: string;
  score: number;
  snippet: string;
}

export interface MemoryDocumentSearchPage {
  results: MemoryDocumentSearchMatch[];
  truncated: boolean;
  warning?: "invalid_fts_query_fallback";
}

export interface MemorySearchPage {
  results: MemoryIndexMatch[];
  truncated: boolean;
  warning?: "invalid_fts_query_fallback";
}

export interface SessionIndexDocument {
  instanceId: string;
  principalId: string;
  sessionId: string;
  entryId: string;
  timestamp: string;
  role: string;
  project: string | null;
  cwd: string | null;
  sourcePath: string;
  sourceOffset: number;
  searchableText: string;
}

export interface SessionSourceState {
  instanceId: string;
  principalId: string;
  sourcePath: string;
  device: number;
  inode: number;
  sizeBytes: number;
  modifiedMs: number;
  completedOffset: number;
  prefixHash: string;
  progress?: SessionSourceProgress;
}

export interface SessionSeenEntry {
  entryId: string;
  byteOffset: number;
}

export interface SessionSourceProgress {
  discardingLine?: boolean;
  completion: "clean-eof" | "budget-exhausted" | "incomplete-tail" | "file-truncated" | "file-replaced";
  warnings: Array<{ code: string; byteOffset?: number }>;
  warningsTruncated: boolean;
}


export interface SessionIndexMatch {
  instanceId: string;
  principalId: string;
  sessionId: string;
  entryId: string;
  timestamp: string;
  role: string;
  project: string | null;
  sourcePath: string;
  sourceOffset: number;
  score: number;
  snippet: string;
}

export interface SessionSearchPage {
  results: SessionIndexMatch[];
  truncated: boolean;
  warning?: "invalid_fts_query_fallback";
}

export interface SessionDocumentSearchRequest {
  query: string;
  limit: number;
  instanceId: string;
  principalId: string;
  roles?: string[];
  from?: string;
  to?: string;
  project?: string;
}

export interface SessionDocumentSearchMatch {
  source: "session";
  sessionId: string;
  entryId: string;
  timestamp: string;
  role: string;
  project?: string;
  sourcePath: string;
  sourceOffset: number;
  score: number;
  snippet: string;
}

export interface SessionDocumentSearchPage {
  results: SessionDocumentSearchMatch[];
  truncated: boolean;
  warning?: "invalid_fts_query_fallback";
}

export interface OpenSearchIndexOptions {
  stateDir: string;
}
