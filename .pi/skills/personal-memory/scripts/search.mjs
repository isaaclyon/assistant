import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  MEMORY_TYPES,
  MEMORY_TYPE_FOLDERS,
  MemoryError,
  parseMarkdownMemoryNote,
  parseHappenings,
  validateHappeningDate,
} from "./store.mjs";

const UUID_NOTE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.md$/u;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 512;
const DEFAULT_MAX_SCANNED_NOTES = 10_000;
const DEFAULT_MAX_WARNINGS = 20;
const MAX_SNIPPET_LENGTH = 240;
const HAPPENINGS_DEFAULT_LIMIT = 50;
const HAPPENINGS_MAX_LIMIT = 100;

function invalid(message) {
  throw new MemoryError("INVALID_INPUT", message);
}

function normalize(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function tokenize(value) {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function validateRequest(request) {
  if (!request || typeof request.query !== "string" || request.query.trim() === "" || request.query.length > MAX_QUERY_LENGTH) {
    invalid("Memory search query is invalid");
  }
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) invalid("Memory search limit is invalid");
  const types = request.types ?? MEMORY_TYPES;
  if (!Array.isArray(types) || types.some((type) => !MEMORY_TYPES.includes(type))) {
    invalid("Memory search types are invalid");
  }
  return { query: request.query, limit, types: [...new Set(types)] };
}

function validateHappeningsRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    invalid("Happenings query is invalid");
  }
  const query = request.query ?? "";
  if (typeof query !== "string" || query.length > MAX_QUERY_LENGTH) invalid("Happenings query is invalid");
  const limit = request.limit ?? HAPPENINGS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > HAPPENINGS_MAX_LIMIT) invalid("Happenings limit is invalid");
  const types = request.types ?? MEMORY_TYPES;
  if (!Array.isArray(types) || types.some((type) => !MEMORY_TYPES.includes(type))) {
    invalid("Happenings memory types are invalid");
  }

  const dates = {};
  for (const key of ["from", "to"]) {
    if (request[key] === undefined) {
      dates[key] = null;
      continue;
    }
    try {
      dates[key] = validateHappeningDate(request[key]);
    } catch {
      invalid(`Happenings ${key} date is invalid`);
    }
  }
  if (dates.from && dates.to && dates.from > dates.to) invalid("Happenings date range is invalid");
  const queryTokens = [...new Set(tokenize(query))];
  return { query, queryTokens, limit, types: [...new Set(types)], from: dates.from, to: dates.to };
}

function scoreNote(note, query, tokens) {
  const title = normalize(note.title);
  const tags = note.tags.map(normalize);
  const body = normalize(note.body);
  const haystack = `${title}\n${tags.join("\n")}\n${body}`;
  if (tokens.some((token) => !haystack.includes(token))) return null;

  const normalizedQuery = normalize(query.trim());
  let score = 0;
  if (title === normalizedQuery) score += 100;
  else if (title.includes(normalizedQuery)) score += 40;
  for (const token of tokens) {
    if (title.includes(token)) score += 20;
    if (tags.some((tag) => tag === token)) score += 10;
    if (body.includes(token)) score += 1;
  }
  return score;
}

function scoreHappening(note, happening, tokens) {
  const title = normalize(note.title);
  const tags = note.tags.map(normalize);
  const text = normalize(happening.text);
  const haystack = `${title}\n${tags.join("\n")}\n${text}`;
  if (tokens.some((token) => !haystack.includes(token))) return null;
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 20;
    if (tags.some((tag) => tag === token)) score += 10;
    if (text.includes(token)) score += 1;
  }
  return score;
}

function snippet(body, tokens) {
  const compact = body.trim().replace(/\s+/gu, " ");
  if (compact.length <= MAX_SNIPPET_LENGTH) return compact;
  const normalized = normalize(compact);
  const first = tokens.reduce((best, token) => {
    const index = normalized.indexOf(token);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const start = Math.max(0, Math.min(first < 0 ? 0 : first - 60, compact.length - MAX_SNIPPET_LENGTH));
  return compact.slice(start, start + MAX_SNIPPET_LENGTH);
}

async function entryKind(path) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "unsafe";
    if (stats.isDirectory()) return "directory";
    return stats.isFile() ? "file" : "unsafe";
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "missing";
    return "unsafe";
  }
}

/**
 * Create the bounded lexical search backend. Markdown remains authoritative;
 * this backend owns no persistent state and can later be replaced by FTS5.
 */
export function createMarkdownMemorySearchBackend(options) {
  if (!options || typeof options.root !== "string" || options.root.trim() === "") {
    invalid("Memory directory is required");
  }
  const root = resolve(options.root);
  const maxScannedNotes = options.maxScannedNotes ?? DEFAULT_MAX_SCANNED_NOTES;
  const maxWarnings = options.maxWarnings ?? DEFAULT_MAX_WARNINGS;
  if (!Number.isInteger(maxScannedNotes) || maxScannedNotes < 1) invalid("Memory scan limit is invalid");
  if (!Number.isInteger(maxWarnings) || maxWarnings < 0) invalid("Memory warning limit is invalid");

  return {
    async search(request) {
      const { query, limit, types } = validateRequest(request);
      const queryTokens = [...new Set(tokenize(query))];
      if (queryTokens.length === 0) invalid("Memory search query is invalid");

      const candidates = [];
      const warningCandidates = [];
      for (const type of types) {
        const folder = MEMORY_TYPE_FOLDERS[type];
        const directory = join(root, folder);
        const directoryKind = await entryKind(directory);
        if (directoryKind === "missing") continue;
        if (directoryKind !== "directory") {
          warningCandidates.push({ code: "UNSAFE_ENTRY", relativePath: folder });
          continue;
        }
        let names;
        try {
          names = await readdir(directory);
        } catch {
          warningCandidates.push({ code: "IO_ERROR", relativePath: folder });
          continue;
        }
        for (const name of names) {
          const match = UUID_NOTE_PATTERN.exec(name);
          if (!match) continue;
          candidates.push({ id: match[1], type, path: join(directory, name), relativePath: join(folder, name) });
        }
      }
      candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      const scanTruncated = candidates.length > maxScannedNotes;
      const results = [];
      const seen = new Set();

      for (const candidate of candidates.slice(0, maxScannedNotes)) {
        if (seen.has(candidate.id)) {
          warningCandidates.push({ code: "DUPLICATE_ID", relativePath: candidate.relativePath });
          continue;
        }
        seen.add(candidate.id);
        if (await entryKind(candidate.path) !== "file") {
          warningCandidates.push({ code: "UNSAFE_ENTRY", relativePath: candidate.relativePath });
          continue;
        }
        try {
          const raw = await readFile(candidate.path, "utf8");
          const note = parseMarkdownMemoryNote(raw, { id: candidate.id, type: candidate.type });
          const score = scoreNote(note, query, queryTokens);
          if (score === null) continue;
          results.push({
            id: note.id,
            relativePath: candidate.relativePath,
            type: note.type,
            title: note.title,
            tags: note.tags,
            created: note.created,
            updated: note.updated,
            revision: note.revision,
            snippet: snippet(note.body, queryTokens),
            score,
          });
        } catch (error) {
          warningCandidates.push({
            code: error instanceof MemoryError ? error.code : "IO_ERROR",
            relativePath: candidate.relativePath,
          });
        }
      }

      results.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
      warningCandidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.code.localeCompare(b.code));
      return {
        results: results.slice(0, limit),
        truncated: results.length > limit,
        scanTruncated,
        warnings: warningCandidates.slice(0, maxWarnings),
        warningsTruncated: warningCandidates.length > maxWarnings,
      };
    },

    async happenings(request) {
      const { queryTokens, limit, types, from, to } = validateHappeningsRequest(request);
      const candidates = [];
      const warningCandidates = [];
      for (const type of types) {
        const folder = MEMORY_TYPE_FOLDERS[type];
        const directory = join(root, folder);
        const directoryKind = await entryKind(directory);
        if (directoryKind === "missing") continue;
        if (directoryKind !== "directory") {
          warningCandidates.push({ code: "UNSAFE_ENTRY", relativePath: folder });
          continue;
        }
        let names;
        try {
          names = await readdir(directory);
        } catch {
          warningCandidates.push({ code: "IO_ERROR", relativePath: folder });
          continue;
        }
        for (const name of names) {
          const match = UUID_NOTE_PATTERN.exec(name);
          if (match) candidates.push({ id: match[1], type, path: join(directory, name), relativePath: join(folder, name) });
        }
      }
      candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      const scanTruncated = candidates.length > maxScannedNotes;
      const results = [];
      const seen = new Set();

      for (const candidate of candidates.slice(0, maxScannedNotes)) {
        if (seen.has(candidate.id)) {
          warningCandidates.push({ code: "DUPLICATE_ID", relativePath: candidate.relativePath });
          continue;
        }
        seen.add(candidate.id);
        if (await entryKind(candidate.path) !== "file") {
          warningCandidates.push({ code: "UNSAFE_ENTRY", relativePath: candidate.relativePath });
          continue;
        }
        try {
          const raw = await readFile(candidate.path, "utf8");
          const note = parseMarkdownMemoryNote(raw, { id: candidate.id, type: candidate.type });
          const happenings = parseHappenings(note.body).entries;
          happenings.forEach((happening, index) => {
            if (from && happening.date < from) return;
            if (to && happening.date > to) return;
            const score = scoreHappening(note, happening, queryTokens);
            if (score === null) return;
            results.push({
              id: note.id,
              relativePath: candidate.relativePath,
              type: note.type,
              title: note.title,
              date: happening.date,
              text: happening.text,
              index,
              score,
            });
          });
        } catch (error) {
          warningCandidates.push({
            code: error instanceof MemoryError ? error.code : "IO_ERROR",
            relativePath: candidate.relativePath,
          });
        }
      }

      results.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id) || a.index - b.index);
      warningCandidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.code.localeCompare(b.code));
      return {
        results: results.slice(0, limit),
        truncated: results.length > limit,
        scanTruncated,
        warnings: warningCandidates.slice(0, maxWarnings),
        warningsTruncated: warningCandidates.length > maxWarnings,
      };
    },
  };
}
