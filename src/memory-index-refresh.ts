import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { MemoryIndexDocument, SearchIndex } from "./search-index.js";

const MAX_WARNINGS = 20;
const MEMORY_TYPE_FOLDERS = {
  person: "people",
  preference: "preferences",
  event: "events",
  list: "lists",
  recipe: "recipes",
  purchase: "purchases",
  reference: "references",
} as const;
export const MEMORY_TYPES = Object.keys(MEMORY_TYPE_FOLDERS);
const UUID_NOTE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.md$/u;
const MAX_MEMORY_NOTE_BYTES = 256 * 1024;
const DEFAULT_MAX_MEMORY_NOTES = 10_000;

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
  complete: boolean;
  indexed: number;
  scanTruncated: boolean;
  warnings: IndexWarning[];
  warningsTruncated: boolean;
}

export interface MemoryRefreshOptions {
  index: SearchIndex;
  vaultRoot: string;
  resourceRoot?: string;
  maxWarnings?: number;
  maxNotes?: number;
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
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

export async function doRebuildMemoryIndex(options: MemoryRefreshOptions): Promise<MemoryRebuildResult> {
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
    return {
      complete: false,
      indexed: 0,
      scanTruncated: false,
      warnings: [{ code: "IO_ERROR", relativePath: "." }],
      warningsTruncated: false,
    };
  }
  const maxNotes = options.maxNotes ?? DEFAULT_MAX_MEMORY_NOTES;
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
  const fingerprint = (stat: Stats): string =>
    JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  let scanned = 0;
  let scanTruncated = false;
  const snapshots = new Map<string, string>();
  const parsed: Array<{ document: MemoryIndexDocument; relativePath: string }> = [];
  for (const candidate of candidates) {
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
    const identity = fingerprint(fileStat);
    snapshots.set(candidate.path, identity);
    const cached = options.index.memoryScan.get(candidate.path);
    if (cached?.fingerprint === identity) {
      if (cached.document) parsed.push({ document: cached.document, relativePath: candidate.relativePath });
      if (cached.warning) warningCandidates.push({ code: cached.warning, relativePath: candidate.relativePath });
      continue;
    }
    if (scanned >= maxNotes) {
      scanTruncated = true;
      continue;
    }
    scanned += 1;
    let document: MemoryIndexDocument | null = null;
    let warning: "MALFORMED_NOTE" | null = null;
    try {
      const handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (fingerprint(await handle.stat()) !== identity) throw new Error("Memory source changed");
        if (fileStat.size > MAX_MEMORY_NOTE_BYTES) {
          warning = "MALFORMED_NOTE";
        } else {
          const buffer = Buffer.alloc(MAX_MEMORY_NOTE_BYTES + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== fileStat.size) throw new Error("Memory source changed");
          const raw = buffer.subarray(0, bytesRead).toString("utf8");
          try {
            const note = memoryStore.parseMarkdownMemoryNote(raw, { id: candidate.id, type: candidate.type });
            document = {
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
            };
          } catch {
            warning = "MALFORMED_NOTE";
          }
        }
        if (fingerprint(await handle.stat()) !== identity ||
            fingerprint(await lstat(candidate.path)) !== identity) {
          throw new Error("Memory source changed");
        }
      } finally {
        await handle.close();
      }
      options.index.memoryScan.set(candidate.path, { fingerprint: identity, document, warning });
      if (document) parsed.push({ document, relativePath: candidate.relativePath });
      if (warning) warningCandidates.push({ code: warning, relativePath: candidate.relativePath });
    } catch {
      warningCandidates.push({ code: "IO_ERROR", relativePath: candidate.relativePath });
    }
  }

  // Recheck staged sources before publishing. Normal privacy edits change ctime
  // even when an external writer restores mtime; never mix an observed edit
  // with earlier staged visibility. Arbitrary external writes remain unlocked.
  for (const [path, identity] of snapshots) {
    try {
      if (fingerprint(await lstat(path)) !== identity) throw new Error("Memory source changed");
    } catch {
      warningCandidates.push({ code: "IO_ERROR", relativePath: relative(vaultRoot, path) });
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

  const complete = !scanTruncated && !warningCandidates.some((warning) =>
    warning.code === "IO_ERROR" || warning.code === "UNSAFE_ENTRY");
  // Keep the last snapshot until discovery and reads finish. Callers must not
  // serve it as fallback: a note's canonical visibility may have changed.
  if (complete) {
    options.index.replaceMemoryDocuments(documents);
    options.index.memoryScan.retain(new Set(candidates.map((candidate) => candidate.path)));
  }
  warningCandidates.sort(
    (a, b) =>
      a.relativePath.localeCompare(b.relativePath) ||
      a.code.localeCompare(b.code),
  );
  const maxWarnings = options.maxWarnings ?? MAX_WARNINGS;
  return {
    complete,
    indexed: complete ? documents.length : 0,
    scanTruncated,
    warnings: warningCandidates.slice(0, maxWarnings),
    warningsTruncated: warningCandidates.length > maxWarnings,
  };
}
