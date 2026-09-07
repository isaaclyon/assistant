import { doRebuildMemoryIndex, MEMORY_TYPES, type MemoryRefreshOptions, type MemoryRebuildResult } from "./memory-index-refresh.js";
export type { IndexWarning, MemoryRebuildResult } from "./memory-index-refresh.js";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  MemoryDocumentSearchPage,
  SessionDocumentSearchPage,
  SessionIndexDocument,
  SearchIndex,
  SessionSourceProgress,
} from "./search-index.js";
import { parseSessionJsonlFile } from "./session-jsonl-parser.js";

const MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
const MAX_WARNINGS = 20;
const DEFAULT_MAX_SESSION_FILES = 10_000;
const DEFAULT_CONTEXT_BEFORE = 2;
const DEFAULT_CONTEXT_AFTER = 2;
const MAX_CONTEXT_NEIGHBORS = 5;
const DEFAULT_CONTEXT_MAX_CHARS = 4_000;
const MIN_CONTEXT_MAX_CHARS = 256;
const MAX_CONTEXT_MAX_CHARS = 12_000;
const MAX_CONTEXT_ENTRY_CHARS = 1_200;

export class SearchInputError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "SearchInputError";
  }
}

export class SessionContextError extends Error {
  readonly code = "SESSION_CONTEXT_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "SessionContextError";
  }
}

export interface IndexedMemorySearchRequest {
  query: string;
  principal: string;
  memoryView: "owner-and-household" | "household" | "none";
  limit?: number;
  types?: string[];
  statuses?: string[];
}

export interface SessionRefreshResult {
  complete: boolean;
  files: number;
  filesTruncated: boolean;
  indexed: number;
  skipped: number;
  rebuiltFiles: number;
  appendedFiles: number;
  unchangedFiles: number;
  deletedFiles: number;
  incompleteFiles: number;
  warnings: Array<{ code: string; sourcePath: string; byteOffset?: number }>;
  warningsTruncated: boolean;
}

export interface IndexedSessionSearchRequest {
  query: string;
  instanceId: string;
  principalId: string;
  limit?: number;
  roles?: string[];
  from?: string;
  to?: string;
  project?: string;
}

export interface SessionContextRequest {
  sessionId: string;
  entryId: string;
  instanceId: string;
  principalId: string;
  roots: string[];
  before?: number;
  after?: number;
  maxChars?: number;
}

export interface SessionContextEntry {
  entryId: string;
  timestamp: string;
  role: string;
  project?: string;
  sourcePath: string;
  sourceOffset: number;
  isTarget: boolean;
  text: string;
  truncated: boolean;
}

export interface SessionContextResult {
  sessionId: string;
  targetEntryId: string;
  entries: SessionContextEntry[];
  beforeReturned: number;
  afterReturned: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  truncated: boolean;
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function hashFilePrefix(path: string, length: number, expected: Stats): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const checkSnapshot = async () => {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== expected.dev || current.ino !== expected.ino ||
        current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) {
      throw new Error("Session source changed during refresh");
    }
  };
  try {
    await checkSnapshot();
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < length) {
      const requested = Math.min(buffer.length, length - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error("Session source changed during refresh");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await checkSnapshot();
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

// Identical overlapping requests share work, while different generations and
// separate DB handles/processes serialize through the same per-corpus lock.
const pendingRefreshes = new WeakMap<SearchIndex, Map<string, Promise<unknown>>>();
function coalesceRefresh<T>(index: SearchIndex, corpus: "memory" | "session", key: string, run: () => Promise<T>): Promise<T> {
  let pending = pendingRefreshes.get(index);
  if (!pending) { pending = new Map(); pendingRefreshes.set(index, pending); }
  const identity = `${corpus}:${key}`;
  const previous = pending.get(identity);
  if (previous) return previous as Promise<T>;
  const promise = index.withRefreshLock(corpus, run);
  pending.set(identity, promise);
  const clear = () => { pending.delete(identity); };
  void promise.then(clear, clear);
  return promise;
}

export function rebuildMemoryIndex(options: MemoryRefreshOptions): Promise<MemoryRebuildResult> {
  const maxNotes = options.maxNotes ?? 10_000;
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 100_000) {
    throw new SearchInputError("Memory rebuild note limit is invalid");
  }
  const { index, ...key } = options;
  return coalesceRefresh(index, "memory", JSON.stringify(key), () => doRebuildMemoryIndex(options));
}

export function searchIndexedMemories(
  index: SearchIndex,
  request: IndexedMemorySearchRequest,
): MemoryDocumentSearchPage {
  const query = request.query?.trim();
  if (!query || request.query.length > 512) {
    throw new SearchInputError("Memory search query is invalid");
  }
  const limit = request.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new SearchInputError("Memory search limit is invalid");
  }
  const types = request.types ?? MEMORY_TYPES;
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    types.some((type) => !MEMORY_TYPES.includes(type))
  ) {
    throw new SearchInputError("Memory search types are invalid");
  }
  const statuses = request.statuses ?? ["active"];
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    statuses.some(
      (status) => !MEMORY_STATUSES.includes(status as (typeof MEMORY_STATUSES)[number]),
    )
  ) {
    throw new SearchInputError("Memory search statuses are invalid");
  }
  return index.searchMemoryDocuments({
    query: request.query,
    limit,
    principal: request.principal,
    memoryView: request.memoryView,
    types,
    statuses,
  });
}

interface SessionRefreshOptions {
  index: SearchIndex;
  roots: string[];
  instanceId: string;
  principalId: string;
  includeSafeCwd?: boolean;
  maxWarnings?: number;
  maxFiles?: number;
  forceRebuild?: boolean;
}

export function refreshSessionIndex(options: SessionRefreshOptions): Promise<SessionRefreshResult> {
  const { index, ...key } = options;
  return coalesceRefresh(index, "session", JSON.stringify(key), () => doRefreshSessionIndex(options));
}

async function doRefreshSessionIndex(options: SessionRefreshOptions): Promise<SessionRefreshResult> {
  if (
    options.roots.length === 0 ||
    options.roots.length > 64 ||
    options.roots.some((root) => !isAbsolute(root)) ||
    new Set(options.roots.map((root) => resolve(root))).size !== options.roots.length
  ) {
    throw new Error("Session roots are invalid");
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_SESSION_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100_000) {
    throw new SearchInputError("Session refresh file limit is invalid");
  }
  const files: string[] = [];
  const discoveredRoots = new Set<string>();
  const warningCandidates: SessionRefreshResult["warnings"] = [];
  for (const root of options.roots.map((value) => resolve(value)).sort()) {
    let entries;
    try {
      const metadata = await lstat(root);
      if (!metadata.isDirectory()) {
        warningCandidates.push({ code: "UNSAFE_ENTRY", sourcePath: root });
        continue;
      }
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      warningCandidates.push({ code: "IO_ERROR", sourcePath: root });
      continue;
    }
    discoveredRoots.add(root);
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) continue;
      const path = join(root, entry.name);
      if (!entry.isFile()) {
        warningCandidates.push({ code: "UNSAFE_ENTRY", sourcePath: path });
        continue;
      }
      files.push(path);
    }
  }
  files.sort();
  const filesTruncated = files.length > maxFiles;
  const discoveredFiles = new Set(files);
  // Discovery is metadata-only and covers all candidates. The parsing budget
  // limits work, not the ability to recognize a previously completed sweep.
  const snapshots = new Map<string, Stats>();
  for (const path of files) {
    try {
      const snapshot = await lstat(path);
      if (!snapshot.isFile()) throw new Error("Unsafe session source");
      snapshots.set(path, snapshot);
    } catch {
      warningCandidates.push({ code: "IO_ERROR", sourcePath: path });
    }
  }
  const cursor = options.index.sessionScanCursor(options.instanceId, options.principalId);
  if (filesTruncated && cursor !== undefined) {
    const start = files.findIndex((path) => path > cursor);
    if (start > 0) files.push(...files.splice(0, start));
  }
  files.splice(maxFiles);

  let indexed = 0;
  let skipped = 0;
  let rebuiltFiles = 0;
  let appendedFiles = 0;
  let unchangedFiles = 0;
  let deletedFiles = 0;
  let incompleteFiles = 0;
  let retainedWarningsTruncated = false;
  const reportProgress = (sourcePath: string, progress: SessionSourceProgress): void => {
    warningCandidates.push(...progress.warnings.map((warning) => ({ sourcePath, ...warning })));
    retainedWarningsTruncated ||= progress.warningsTruncated;
    if (progress.completion !== "clean-eof") incompleteFiles += 1;
  };
  for (const path of files) {
    try {
      const fileStat = await lstat(path);
      const previous = options.index.getSessionSourceState(
        options.instanceId,
        options.principalId,
        path,
      );
      const modifiedMs = Math.trunc(fileStat.mtimeMs);
      if (
        !options.forceRebuild &&
        previous &&
        previous.progress !== undefined &&
        previous.progress.completion !== "budget-exhausted" &&
        previous.device === fileStat.dev &&
        previous.inode === fileStat.ino &&
        previous.sizeBytes === fileStat.size &&
        previous.modifiedMs === modifiedMs
      ) {
        unchangedFiles += 1;
        continue;
      }
      const appendCandidate =
        !options.forceRebuild &&
        previous !== undefined &&
        previous.progress !== undefined &&
        previous.device === fileStat.dev &&
        previous.inode === fileStat.ino &&
        fileStat.size >= previous.sizeBytes &&
        (fileStat.size > previous.sizeBytes || previous.progress.completion === "budget-exhausted");
      const canAppend =
        appendCandidate &&
        fileStat.size >= previous.completedOffset &&
        (await hashFilePrefix(path, previous.completedOffset, fileStat)) === previous.prefixHash;
      let parsed = await parseSessionJsonlFile({
        path,
        instanceId: options.instanceId,
        principal: options.principalId,
        ...(canAppend ? {
          offset: previous.completedOffset,
          discardingLine: previous.progress?.discardingLine ?? false,
          previousFile: {
            device: previous.device,
            inode: previous.inode,
            size: previous.sizeBytes,
          },
          seenEntryIds: options.index.getSessionEntryIds(
            options.instanceId,
            options.principalId,
            path,
          ),
        } : {}),
        ...(options.includeSafeCwd === undefined
          ? {}
          : { includeSafeCwd: options.includeSafeCwd }),
      });
      let append = canAppend;
      if (
        parsed.completion === "file-replaced" ||
        parsed.completion === "file-truncated"
      ) {
        parsed = await parseSessionJsonlFile({
          path,
          instanceId: options.instanceId,
          principal: options.principalId,
          ...(options.includeSafeCwd === undefined
            ? {}
            : { includeSafeCwd: options.includeSafeCwd }),
        });
        append = false;
      }
      const fileDocuments: SessionIndexDocument[] = [];
      for (const document of parsed.documents) {
        const indexedDocument = {
          instanceId: document.instanceId,
          principalId: document.principal,
          sessionId: document.sessionId,
          entryId: document.entryId,
          timestamp: document.timestamp,
          role: document.role,
          project: document.cwd ? basename(document.cwd) : null,
          cwd: document.cwd ?? null,
          sourcePath: document.source.path,
          sourceOffset: document.source.byteOffset,
          searchableText: document.text,
        };
        fileDocuments.push(indexedDocument);
      }
      const warnings = [
        ...(append ? (previous?.progress?.warnings ?? []).filter((warning) =>
          warning.code !== "TOTAL_OUTPUT_LIMIT" && warning.code !== "FILE_LIMIT") : []),
        ...parsed.findings.map((finding) => ({ code: finding.code,
          ...(finding.byteOffset === undefined ? {} : { byteOffset: finding.byteOffset }) })),
      ];
      const progress: SessionSourceProgress = {
        completion: parsed.completion,
        ...(parsed.discardingLine === undefined ? {} : { discardingLine: parsed.discardingLine }),
        warnings: warnings.slice(0, MAX_WARNINGS),
        warningsTruncated: warnings.length > MAX_WARNINGS || (append && (previous?.progress?.warningsTruncated ?? false)),
      };
      const state = {
        instanceId: options.instanceId,
        principalId: options.principalId,
        sourcePath: path,
        device: parsed.file.device,
        inode: parsed.file.inode,
        sizeBytes: parsed.file.size,
        modifiedMs,
        completedOffset: parsed.nextOffset,
        prefixHash: await hashFilePrefix(path, parsed.nextOffset, fileStat),
        progress,
      };
      if (append) {
        options.index.appendSessionSource(state, fileDocuments, parsed.seenEntries);
        appendedFiles += 1;
      } else {
        options.index.replaceSessionSource(state, fileDocuments, parsed.seenEntries);
        rebuiltFiles += 1;
      }
      indexed += fileDocuments.length;
      skipped += parsed.findings.length;
    } catch {
      skipped += 1;
      warningCandidates.push({ code: "IO_ERROR", sourcePath: path });
    }
  }
  if (files.length > 0) {
    options.index.setSessionScanCursor(options.instanceId, options.principalId, files.at(-1)!);
  }
  // Check every discovered source, not only this pass's bounded subset.
  // This also invalidates coverage immediately when an unvisited file changes.
  for (const path of discoveredFiles) {
    const snapshot = snapshots.get(path);
    const state = options.index.getSessionSourceState(options.instanceId, options.principalId, path);
    if (!snapshot || !state?.progress || state.device !== snapshot.dev ||
        state.inode !== snapshot.ino || state.sizeBytes !== snapshot.size ||
        state.modifiedMs !== Math.trunc(snapshot.mtimeMs)) {
      incompleteFiles += 1;
      continue;
    }
    reportProgress(path, state.progress);
  }
  for (const state of options.index.listSessionSourceStates(
    options.instanceId,
    options.principalId,
  )) {
    if (discoveredFiles.has(state.sourcePath)) continue;
    const root = options.roots.find((root) => isWithin(state.sourcePath, resolve(root)));
    // Failed discovery is stale coverage, not proof of deletion. Removed roots
    // are no longer authorized and must not leave searchable private evidence.
    if (root !== undefined && !discoveredRoots.has(resolve(root))) continue;
    options.index.deleteSessionSource(
      options.instanceId,
      options.principalId,
      state.sourcePath,
    );
    deletedFiles += 1;
  }
  warningCandidates.sort(
    (a, b) =>
      a.sourcePath.localeCompare(b.sourcePath) ||
      (a.byteOffset ?? -1) - (b.byteOffset ?? -1) ||
      a.code.localeCompare(b.code),
  );
  const maxWarnings = options.maxWarnings ?? MAX_WARNINGS;
  return {
    complete: incompleteFiles === 0 && !warningCandidates.some((warning) =>
      warning.code === "IO_ERROR" || warning.code === "UNSAFE_ENTRY"),
    files: files.length,
    filesTruncated,
    indexed,
    skipped,
    rebuiltFiles,
    appendedFiles,
    unchangedFiles,
    deletedFiles,
    incompleteFiles,
    warnings: warningCandidates.slice(0, maxWarnings),
    warningsTruncated: retainedWarningsTruncated || warningCandidates.length > maxWarnings,
  };
}

export async function rebuildSessionIndex(options: {
  index: SearchIndex;
  roots: string[];
  instanceId: string;
  principalId: string;
  includeSafeCwd?: boolean;
  maxWarnings?: number;
  maxFiles?: number;
}): Promise<SessionRefreshResult> {
  return refreshSessionIndex({ ...options, forceRebuild: true });
}

function validateCanonicalTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    throw new SearchInputError(`${label} is invalid`);
  }
  return value;
}

export function searchIndexedSessions(
  index: SearchIndex,
  request: IndexedSessionSearchRequest,
): SessionDocumentSearchPage {
  const query = request.query?.trim();
  if (!query || request.query.length > 512) {
    throw new SearchInputError("Session search query is invalid");
  }
  const limit = request.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new SearchInputError("Session search limit is invalid");
  }
  const roles = request.roles ?? ["user", "assistant", "toolResult"];
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some((role) => !["user", "assistant", "toolResult"].includes(role))
  ) {
    throw new SearchInputError("Session search roles are invalid");
  }
  const from = validateCanonicalTimestamp(request.from, "Session search from timestamp");
  const to = validateCanonicalTimestamp(request.to, "Session search to timestamp");
  if (from && to && from > to) {
    throw new SearchInputError("Session search date range is invalid");
  }
  if (
    request.project !== undefined &&
    (request.project.trim() !== request.project ||
      request.project.length === 0 ||
      request.project.length > 200)
  ) {
    throw new SearchInputError("Session search project is invalid");
  }
  return index.searchSessionDocuments({
    query: request.query,
    limit,
    instanceId: request.instanceId,
    principalId: request.principalId,
    roles,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(request.project === undefined ? {} : { project: request.project }),
  });
}

function validateContextCount(value: number | undefined, label: string, fallback: number): number {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < 0 || count > MAX_CONTEXT_NEIGHBORS) {
    throw new SearchInputError(`${label} is invalid`);
  }
  return count;
}

function validateContextString(value: string, label: string): string {
  if (value.trim() !== value || value.length === 0 || value.length > 256) {
    throw new SearchInputError(`${label} is invalid`);
  }
  return value;
}

function boundContextText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return { text: value, truncated: false };
  return { text: `${characters.slice(0, Math.max(0, maxChars - 1)).join("")}…`, truncated: true };
}

export async function readSessionContext(
  index: SearchIndex,
  request: SessionContextRequest,
): Promise<SessionContextResult> {
  const sessionId = validateContextString(request.sessionId, "Session context session ID");
  const entryId = validateContextString(request.entryId, "Session context entry ID");
  if (
    request.roots.length === 0 ||
    request.roots.some((root) => !isAbsolute(root))
  ) {
    throw new SearchInputError("Session context roots are invalid");
  }
  const before = validateContextCount(request.before, "Session context before count", DEFAULT_CONTEXT_BEFORE);
  const after = validateContextCount(request.after, "Session context after count", DEFAULT_CONTEXT_AFTER);
  const maxChars = request.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < MIN_CONTEXT_MAX_CHARS || maxChars > MAX_CONTEXT_MAX_CHARS) {
    throw new SearchInputError("Session context character budget is invalid");
  }

  const anchor = index.getSessionDocument(
    request.instanceId,
    request.principalId,
    sessionId,
    entryId,
  );
  if (anchor === undefined) {
    throw new SessionContextError("Session context entry was not found in the index");
  }
  const sourcePath = resolve(anchor.sourcePath);
  const root = request.roots.find((root) => dirname(sourcePath) === resolve(root));
  if (root === undefined) {
    throw new SessionContextError("Session context source is outside the active session roots");
  }

  const contextStart = index.sessionContextStart(request.instanceId, request.principalId, sourcePath, anchor.sourceOffset, before);
  let parsed;
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error("Unsafe session root");
    parsed = await parseSessionJsonlFile({
      path: sourcePath,
      instanceId: request.instanceId,
      principal: request.principalId,
      includeSafeCwd: true,
      offset: contextStart.offset,
      seenEntryIds: index.getSessionEntryIds(request.instanceId, request.principalId, sourcePath, contextStart.offset),
    });
  } catch {
    throw new SessionContextError("Session context source is unavailable");
  }
  const documents = parsed.documents.filter((document) => document.sessionId === sessionId);
  const targetIndex = documents.findIndex((document) => document.entryId === entryId && document.source.byteOffset === anchor.sourceOffset);
  if (targetIndex < 0) {
    throw new SessionContextError("Session context entry is no longer available in the source");
  }

  const start = Math.max(0, targetIndex - before);
  const end = Math.min(documents.length, targetIndex + after + 1);
  const selected = documents.slice(start, end);
  const perEntryBudget = Math.max(1, Math.floor(maxChars / selected.length));
  const entries = selected.map((document) => {
    const bounded = boundContextText(
      document.text,
      Math.min(MAX_CONTEXT_ENTRY_CHARS, perEntryBudget),
    );
    return {
      entryId: document.entryId,
      timestamp: document.timestamp,
      role: document.role,
      ...(document.cwd === undefined ? {} : { project: basename(document.cwd) }),
      sourcePath: document.source.path,
      sourceOffset: document.source.byteOffset,
      isTarget: document.entryId === entryId,
      text: bounded.text,
      truncated: document.truncated || bounded.truncated,
    };
  });

  return {
    sessionId,
    targetEntryId: entryId,
    entries,
    beforeReturned: targetIndex - start,
    afterReturned: end - targetIndex - 1,
    hasMoreBefore: contextStart.hasMoreBefore || start > 0,
    hasMoreAfter: end < documents.length || parsed.completion !== "clean-eof",
    truncated: entries.some((entry) => entry.truncated),
  };
}
