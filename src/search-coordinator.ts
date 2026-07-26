import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  MemoryDocumentSearchPage,
  MemoryIndexDocument,
  SessionDocumentSearchPage,
  SessionIndexDocument,
  SearchIndex,
} from "./search-index.js";
import { parseSessionJsonlFile } from "./session-jsonl-parser.js";

const MEMORY_TYPE_FOLDERS = {
  person: "people",
  preference: "preferences",
  event: "events",
  list: "lists",
  recipe: "recipes",
  purchase: "purchases",
  reference: "references",
} as const;
const MEMORY_TYPES = Object.keys(MEMORY_TYPE_FOLDERS);
const MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
const UUID_NOTE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.md$/u;
const MAX_MEMORY_NOTE_BYTES = 256 * 1024;
const MAX_WARNINGS = 20;
const DEFAULT_MAX_MEMORY_NOTES = 10_000;
const DEFAULT_MAX_SESSION_FILES = 10_000;

export class SearchInputError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "SearchInputError";
  }
}

interface ParsedMemoryNote {
  schema: number;
  id: string;
  type: string;
  status: string;
  scope: string;
  owner?: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  revision: string;
  body: string;
}

interface MemoryStoreModule {
  createMarkdownMemoryStore(options: {
    root: string;
    forbiddenRoots: string[];
  }): { verifyRoot(): Promise<boolean> };
  parseMarkdownMemoryNote(
    raw: string,
    expected: { id: string; type: string },
  ): ParsedMemoryNote;
}

export interface IndexWarning {
  code: "DUPLICATE_ID" | "IO_ERROR" | "MALFORMED_NOTE" | "UNSAFE_ENTRY";
  relativePath: string;
}

export interface MemoryRebuildResult {
  indexed: number;
  scanTruncated: boolean;
  warnings: IndexWarning[];
  warningsTruncated: boolean;
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
  files: number;
  filesTruncated: boolean;
  indexed: number;
  skipped: number;
  rebuiltFiles: number;
  appendedFiles: number;
  unchangedFiles: number;
  deletedFiles: number;
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

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function hashFilePrefix(path: string, length: number): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < length) {
      const requested = Math.min(buffer.length, length - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error("Session source changed during refresh");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function loadMemoryStoreModule(resourceRoot: string): Promise<MemoryStoreModule> {
  const modulePath = join(
    resourceRoot,
    ".pi",
    "skills",
    "personal-memory",
    "scripts",
    "store.mjs",
  );
  return import(pathToFileURL(modulePath).href) as Promise<MemoryStoreModule>;
}

export async function rebuildMemoryIndex(options: {
  index: SearchIndex;
  vaultRoot: string;
  resourceRoot?: string;
  maxWarnings?: number;
  maxNotes?: number;
}): Promise<MemoryRebuildResult> {
  const vaultRoot = resolve(options.vaultRoot);
  const resourceRoot = resolve(
    options.resourceRoot ??
      process.env.PI_TELEGRAM_BRIDGE_RESOURCE_ROOT ??
      process.cwd(),
  );
  const memoryStore = await loadMemoryStoreModule(resourceRoot);
  const verifiedStore = memoryStore.createMarkdownMemoryStore({
    root: vaultRoot,
    forbiddenRoots: [resourceRoot],
  });
  if (!(await verifiedStore.verifyRoot())) {
    options.index.replaceMemoryDocuments([]);
    return {
      indexed: 0,
      scanTruncated: false,
      warnings: [],
      warningsTruncated: false,
    };
  }
  const maxNotes = options.maxNotes ?? DEFAULT_MAX_MEMORY_NOTES;
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 100_000) {
    throw new SearchInputError("Memory rebuild note limit is invalid");
  }
  const candidates: Array<{
    id: string;
    type: string;
    path: string;
    relativePath: string;
  }> = [];
  const warningCandidates: IndexWarning[] = [];

  for (const [type, folder] of Object.entries(MEMORY_TYPE_FOLDERS)) {
    const directory = join(vaultRoot, folder);
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      warningCandidates.push({ code: "IO_ERROR", relativePath: folder });
      continue;
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      warningCandidates.push({ code: "UNSAFE_ENTRY", relativePath: folder });
      continue;
    }
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      warningCandidates.push({ code: "IO_ERROR", relativePath: folder });
      continue;
    }
    for (const name of names) {
      const match = UUID_NOTE_PATTERN.exec(name);
      if (!match) continue;
      const path = join(directory, name);
      if (!isWithin(path, vaultRoot)) {
        warningCandidates.push({
          code: "UNSAFE_ENTRY",
          relativePath: join(folder, name),
        });
        continue;
      }
      candidates.push({
        id: match[1]!,
        type,
        path,
        relativePath: join(folder, name),
      });
    }
  }
  candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const scanTruncated = candidates.length > maxNotes;
  const scannedCandidates = candidates.slice(0, maxNotes);

  const parsed: Array<{ document: MemoryIndexDocument; relativePath: string }> = [];
  for (const candidate of scannedCandidates) {
    let fileStat;
    try {
      fileStat = await lstat(candidate.path);
    } catch {
      warningCandidates.push({
        code: "IO_ERROR",
        relativePath: candidate.relativePath,
      });
      continue;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      warningCandidates.push({
        code: "UNSAFE_ENTRY",
        relativePath: candidate.relativePath,
      });
      continue;
    }
    if (fileStat.size > MAX_MEMORY_NOTE_BYTES) {
      warningCandidates.push({
        code: "MALFORMED_NOTE",
        relativePath: candidate.relativePath,
      });
      continue;
    }
    try {
      const raw = await readFile(candidate.path, "utf8");
      const note = memoryStore.parseMarkdownMemoryNote(raw, {
        id: candidate.id,
        type: candidate.type,
      });
      parsed.push({
        relativePath: candidate.relativePath,
        document: {
          noteId: note.id,
          relativePath: candidate.relativePath,
          revision: note.revision,
          title: note.title,
          tags: note.tags,
          body: note.body,
          type: note.type,
          status: note.status,
          scope: note.scope,
          owner: note.owner ?? null,
          createdAt: note.created,
          updatedAt: note.updated,
        },
      });
    } catch {
      warningCandidates.push({
        code: "MALFORMED_NOTE",
        relativePath: candidate.relativePath,
      });
    }
  }

  const counts = new Map<string, number>();
  for (const entry of parsed) {
    counts.set(entry.document.noteId, (counts.get(entry.document.noteId) ?? 0) + 1);
  }
  const documents = parsed
    .filter((entry) => {
      if (counts.get(entry.document.noteId) === 1) return true;
      warningCandidates.push({
        code: "DUPLICATE_ID",
        relativePath: entry.relativePath,
      });
      return false;
    })
    .map((entry) => entry.document);

  options.index.replaceMemoryDocuments(documents);
  warningCandidates.sort(
    (a, b) =>
      a.relativePath.localeCompare(b.relativePath) ||
      a.code.localeCompare(b.code),
  );
  const maxWarnings = options.maxWarnings ?? MAX_WARNINGS;
  return {
    indexed: documents.length,
    scanTruncated,
    warnings: warningCandidates.slice(0, maxWarnings),
    warningsTruncated: warningCandidates.length > maxWarnings,
  };
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

export async function refreshSessionIndex(options: {
  index: SearchIndex;
  roots: string[];
  instanceId: string;
  principalId: string;
  includeSafeCwd?: boolean;
  maxWarnings?: number;
  maxFiles?: number;
}): Promise<SessionRefreshResult> {
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
  const warningCandidates: SessionRefreshResult["warnings"] = [];
  for (const root of options.roots.map((value) => resolve(value)).sort()) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      warningCandidates.push({ code: "IO_ERROR", sourcePath: root });
      continue;
    }
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
  files.splice(maxFiles);

  const documents: SessionIndexDocument[] = [];
  let skipped = 0;
  let rebuiltFiles = 0;
  let appendedFiles = 0;
  let unchangedFiles = 0;
  let deletedFiles = 0;
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
        previous &&
        previous.device === fileStat.dev &&
        previous.inode === fileStat.ino &&
        previous.sizeBytes === fileStat.size &&
        previous.modifiedMs === modifiedMs
      ) {
        unchangedFiles += 1;
        continue;
      }
      const appendCandidate =
        previous !== undefined &&
        previous.device === fileStat.dev &&
        previous.inode === fileStat.ino &&
        fileStat.size > previous.sizeBytes;
      const canAppend =
        appendCandidate &&
        fileStat.size >= previous.completedOffset &&
        (await hashFilePrefix(path, previous.completedOffset)) === previous.prefixHash;
      let parsed = await parseSessionJsonlFile({
        path,
        instanceId: options.instanceId,
        principal: options.principalId,
        ...(canAppend ? {
          offset: previous.completedOffset,
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
        documents.push(indexedDocument);
      }
      const state = {
        instanceId: options.instanceId,
        principalId: options.principalId,
        sourcePath: path,
        device: parsed.file.device,
        inode: parsed.file.inode,
        sizeBytes: parsed.file.size,
        modifiedMs,
        completedOffset: parsed.nextOffset,
        prefixHash: await hashFilePrefix(path, parsed.nextOffset),
      };
      if (append) {
        options.index.appendSessionSource(state, fileDocuments);
        appendedFiles += 1;
      } else {
        options.index.replaceSessionSource(state, fileDocuments);
        rebuiltFiles += 1;
      }
      skipped += parsed.findings.length;
      for (const finding of parsed.findings) {
        warningCandidates.push({
          code: finding.code,
          sourcePath: finding.path,
          ...(finding.byteOffset === undefined
            ? {}
            : { byteOffset: finding.byteOffset }),
        });
      }
    } catch {
      skipped += 1;
      warningCandidates.push({ code: "IO_ERROR", sourcePath: path });
    }
  }
  const currentFiles = new Set(files);
  for (const state of options.index.listSessionSourceStates(
    options.instanceId,
    options.principalId,
  )) {
    if (currentFiles.has(state.sourcePath)) continue;
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
    files: files.length,
    filesTruncated,
    indexed: documents.length,
    skipped,
    rebuiltFiles,
    appendedFiles,
    unchangedFiles,
    deletedFiles,
    warnings: warningCandidates.slice(0, maxWarnings),
    warningsTruncated: warningCandidates.length > maxWarnings,
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
    throw new SearchInputError("Session rebuild file limit is invalid");
  }
  const files: string[] = [];
  const warningCandidates: SessionRefreshResult["warnings"] = [];
  for (const root of options.roots.map((value) => resolve(value)).sort()) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      warningCandidates.push({ code: "IO_ERROR", sourcePath: root });
      continue;
    }
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
  files.splice(maxFiles);

  const documents: SessionIndexDocument[] = [];
  const states = [];
  let skipped = 0;
  for (const path of files) {
    try {
      const fileStat = await lstat(path);
      const parsed = await parseSessionJsonlFile({
        path,
        instanceId: options.instanceId,
        principal: options.principalId,
        ...(options.includeSafeCwd === undefined
          ? {}
          : { includeSafeCwd: options.includeSafeCwd }),
      });
      for (const document of parsed.documents) {
        documents.push({
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
        });
      }
      states.push({
        instanceId: options.instanceId,
        principalId: options.principalId,
        sourcePath: path,
        device: parsed.file.device,
        inode: parsed.file.inode,
        sizeBytes: parsed.file.size,
        modifiedMs: Math.trunc(fileStat.mtimeMs),
        completedOffset: parsed.nextOffset,
        prefixHash: await hashFilePrefix(path, parsed.nextOffset),
      });
      skipped += parsed.findings.length;
      for (const finding of parsed.findings) {
        warningCandidates.push({
          code: finding.code,
          sourcePath: finding.path,
          ...(finding.byteOffset === undefined
            ? {}
            : { byteOffset: finding.byteOffset }),
        });
      }
    } catch {
      skipped += 1;
      warningCandidates.push({ code: "IO_ERROR", sourcePath: path });
    }
  }

  options.index.replaceSessionCorpus(
    options.instanceId,
    options.principalId,
    states,
    documents,
  );
  warningCandidates.sort(
    (a, b) =>
      a.sourcePath.localeCompare(b.sourcePath) ||
      (a.byteOffset ?? -1) - (b.byteOffset ?? -1) ||
      a.code.localeCompare(b.code),
  );
  const maxWarnings = options.maxWarnings ?? MAX_WARNINGS;
  return {
    files: files.length,
    filesTruncated,
    indexed: documents.length,
    skipped,
    rebuiltFiles: files.length,
    appendedFiles: 0,
    unchangedFiles: 0,
    deletedFiles: 0,
    warnings: warningCandidates.slice(0, maxWarnings),
    warningsTruncated: warningCandidates.length > maxWarnings,
  };
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
