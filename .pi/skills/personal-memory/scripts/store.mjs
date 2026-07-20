import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";

export const MEMORY_TYPES = Object.freeze([
  "person",
  "preference",
  "event",
  "list",
  "recipe",
  "purchase",
  "reference",
]);
export const MEMORY_STATUSES = Object.freeze(["active", "superseded", "archived"]);

export const MEMORY_TYPE_FOLDERS = Object.freeze({
  person: "people",
  preference: "preferences",
  event: "events",
  list: "lists",
  recipe: "recipes",
  purchase: "purchases",
  reference: "references",
});
const NOTE_SCHEMA_VERSION = 1;
const REQUIRED_MANAGED_KEYS = new Set(["schema", "id", "type", "title", "tags", "created", "updated"]);
const MANAGED_KEYS = new Set([...REQUIRED_MANAGED_KEYS, "status"]);
export const MEMORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_MEMORY_NOTE_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const MAX_HAPPENING_TEXT_LENGTH = 2_000;
const HAPPENINGS_HEADING = "## Happenings";
const HAPPENING_DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;

export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MemoryError(code, message);
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

function isWithin(candidate, parent) {
  const child = resolve(candidate);
  const root = resolve(parent);
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertOutsideForbidden(candidate, forbiddenRoots) {
  if (forbiddenRoots.some((forbidden) => isWithin(candidate, forbidden))) {
    fail("UNSAFE_VAULT", "Memory directory is not in a safe location");
  }
}

async function canonicalizeRoots(paths) {
  return Promise.all(paths.map(async (path) => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  }));
}

async function assertSafeCreationParent(path, forbiddenRoots) {
  let parent = dirname(path);
  while (true) {
    let stat;
    try {
      stat = await lstat(parent);
    } catch (error) {
      if (!isMissing(error)) fail("UNSAFE_VAULT", "Memory directory is not in a safe location");
      const next = dirname(parent);
      if (next === parent) fail("UNSAFE_VAULT", "Memory directory is not in a safe location");
      parent = next;
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("UNSAFE_VAULT", "Memory directory is not in a safe location");
    }
    let canonicalParent;
    try {
      canonicalParent = await realpath(parent);
    } catch {
      fail("UNSAFE_VAULT", "Memory directory is not in a safe location");
    }
    const candidate = resolve(canonicalParent, relative(parent, path));
    assertOutsideForbidden(candidate, await canonicalizeRoots(forbiddenRoots));
    return;
  }
}

function validateId(id) {
  if (typeof id !== "string" || !MEMORY_ID_PATTERN.test(id)) {
    fail("INVALID_ID", "Memory id is invalid");
  }
  return id;
}

function validateType(type) {
  if (!MEMORY_TYPES.includes(type)) fail("INVALID_INPUT", "Memory type is invalid");
  return type;
}

function validateStatus(status) {
  if (!MEMORY_STATUSES.includes(status)) fail("INVALID_INPUT", "Memory status is invalid");
  return status;
}

function validateStatuses(statuses = ["active"]) {
  if (!Array.isArray(statuses)) fail("INVALID_INPUT", "Memory statuses are invalid");
  return [...new Set(statuses.map(validateStatus))];
}

function validateTitle(title) {
  if (
    typeof title !== "string" ||
    title.trim() !== title ||
    title.length === 0 ||
    title.length > MAX_TITLE_LENGTH ||
    /[\r\n]/u.test(title)
  ) {
    fail("INVALID_INPUT", "Memory title is invalid");
  }
  return title;
}

function validateTags(tags = []) {
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    fail("INVALID_INPUT", "Memory tags are invalid");
  }
  const seen = new Set();
  return tags.map((tag) => {
    if (
      typeof tag !== "string" ||
      tag.trim() !== tag ||
      tag.length === 0 ||
      tag.length > MAX_TAG_LENGTH ||
      /[\r\n]/u.test(tag) ||
      seen.has(tag)
    ) {
      fail("INVALID_INPUT", "Memory tags are invalid");
    }
    seen.add(tag);
    return tag;
  });
}

function validateBody(body) {
  if (typeof body !== "string" || body.includes("\0")) {
    fail("INVALID_INPUT", "Memory body is invalid");
  }
  return body;
}

export function validateHappeningDate(date) {
  if (typeof date !== "string" || !HAPPENING_DATE_PATTERN.test(date)) {
    fail("INVALID_INPUT", "Happening date must be YYYY-MM-DD");
  }
  const [, yearSource, monthSource, daySource] = HAPPENING_DATE_PATTERN.exec(date);
  const year = Number(yearSource);
  const month = Number(monthSource);
  const day = Number(daySource);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    fail("INVALID_INPUT", "Happening date must be a valid calendar date");
  }
  return date;
}

function validateHappeningText(text) {
  if (
    typeof text !== "string" ||
    text.trim() !== text ||
    text.length === 0 ||
    text.length > MAX_HAPPENING_TEXT_LENGTH ||
    /[\r\n\0]/u.test(text)
  ) {
    fail("INVALID_INPUT", "Happening text is invalid");
  }
  return text;
}

function headingKind(line) {
  return /^(?:#|##)[ \t]+/u.test(line) ? "section" : null;
}

export function parseHappenings(body) {
  validateBody(body);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\n/u).map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() !== HAPPENINGS_HEADING) continue;
    if (sections.length > 0) fail("MALFORMED_NOTE", "Memory note has duplicate Happenings sections");
    const start = index + 1;
    let end = lines.length;
    for (let cursor = start; cursor < lines.length; cursor += 1) {
      if (headingKind(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    const entries = [];
    let previousDate = "";
    for (let cursor = start; cursor < end; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === "") continue;
      const match = /^-[ \t]([0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]—[ \t](.+?)[ \t]*$/u.exec(line);
      if (!match) fail("MALFORMED_NOTE", "Memory note has malformed Happenings entries");
      const date = match[1];
      let text;
      try {
        validateHappeningDate(date);
        text = validateHappeningText(match[2]);
      } catch {
        fail("MALFORMED_NOTE", "Memory note has malformed Happenings entries");
      }
      if (previousDate && date < previousDate) {
        fail("MALFORMED_NOTE", "Memory note Happenings are not chronological");
      }
      previousDate = date;
      entries.push({ date, text, line: cursor });
    }
    sections.push({ start, end, entries, newline });
    index = end - 1;
  }

  return sections[0] ?? { start: null, end: null, entries: [], newline };
}

function appendHappening(body, { date, text } = {}) {
  validateBody(body);
  validateHappeningDate(date);
  validateHappeningText(text);
  const parsed = parseHappenings(body);
  if (parsed.entries.some((entry) => entry.date === date && entry.text === text)) {
    fail("DUPLICATE_HAPPENING", "Happening is already recorded");
  }
  const line = `- ${date} — ${text}`;
  const newline = parsed.newline;
  if (parsed.start === null) {
    let separator = `${newline}${newline}`;
    if (body === "" || body.endsWith(`${newline}${newline}`)) separator = "";
    else if (body.endsWith(newline)) separator = newline;
    return `${body}${separator}${HAPPENINGS_HEADING}${newline}${newline}${line}${newline}`;
  }

  const lines = body.split(/\n/u).map((source) => source.endsWith("\r") ? source.slice(0, -1) : source);
  const insertBefore = parsed.entries.find((entry) => entry.date > date);
  const insertAt = insertBefore?.line ?? (parsed.entries.at(-1)?.line ?? parsed.start);
  if (!insertBefore && parsed.entries.length > 0) {
    lines.splice(insertAt + 1, 0, line);
  } else {
    lines.splice(insertAt, 0, line);
  }
  return lines.join(newline);
}

function validateTimestamp(value) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  return value;
}

function digest(raw) {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export function parseMarkdownMemoryNote(raw, expected = {}) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_MEMORY_NOTE_BYTES) {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  const frontmatter = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu.exec(raw);
  if (!frontmatter) fail("MALFORMED_NOTE", "Memory note is malformed");
  const document = parseDocument(frontmatter[1], { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  let values;
  try {
    values = document.toJS({ maxAliasCount: 100 });
  } catch {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  const hasStatus = Object.hasOwn(values, "status");
  for (const key of REQUIRED_MANAGED_KEYS) {
    if (!Object.hasOwn(values, key)) fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  try {
    if (values.schema !== NOTE_SCHEMA_VERSION) fail("MALFORMED_NOTE", "Memory note is malformed");
    values.id = validateId(values.id);
    values.type = validateType(values.type);
    values.status = validateStatus(Object.hasOwn(values, "status") ? values.status : "active");
    values.title = validateTitle(values.title);
    values.tags = validateTags(values.tags);
    values.created = validateTimestamp(values.created);
    values.updated = validateTimestamp(values.updated);
  } catch {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  if (expected.id && values.id !== expected.id) fail("MALFORMED_NOTE", "Memory note is malformed");
  if (expected.type && values.type !== expected.type) fail("MALFORMED_NOTE", "Memory note is malformed");
  const body = raw.slice(frontmatter[0].length);
  validateBody(body);
  parseHappenings(body);
  return {
    ...values,
    body,
    frontmatterDocument: document,
    frontmatterValues: Object.fromEntries(
      [...MANAGED_KEYS].map((key) => [key, key === "status" && !hasStatus ? undefined : values[key]]),
    ),
    revision: digest(raw),
  };
}

function renderNote(note) {
  parseHappenings(note.body);
  const managed = {
    schema: NOTE_SCHEMA_VERSION,
    id: note.id,
    type: note.type,
    status: note.status,
    title: note.title,
    tags: note.tags,
    created: note.created,
    updated: note.updated,
  };
  let header;
  if (note.frontmatterDocument) {
    const document = note.frontmatterDocument.clone();
    for (const [key, value] of Object.entries(managed)) {
      if (JSON.stringify(note.frontmatterValues?.[key]) === JSON.stringify(value)) continue;
      const sourceNode = document.get(key, true);
      document.set(key, document.createNode(value));
      const targetNode = document.get(key, true);
      if (!sourceNode || !targetNode || typeof sourceNode !== "object" || typeof targetNode !== "object") continue;
      const properties = ["comment", "commentBefore", "spaceBefore", "anchor", "flow", "type", "format"];
      for (const property of properties) {
        if (sourceNode[property] !== undefined) targetNode[property] = sourceNode[property];
      }
      if (!Array.isArray(sourceNode.items) || !Array.isArray(targetNode.items)) continue;
      const matchedSourceItems = new Set();
      const sourceIndexes = targetNode.items.map((targetItem) => {
        const index = sourceNode.items.findIndex(
          (sourceItem, sourceIndex) => !matchedSourceItems.has(sourceIndex) && sourceItem?.value === targetItem?.value,
        );
        if (index >= 0) matchedSourceItems.add(index);
        return index;
      });
      for (const [targetIndex, targetItem] of targetNode.items.entries()) {
        if (sourceIndexes[targetIndex] < 0 && sourceNode.items[targetIndex] && !matchedSourceItems.has(targetIndex)) {
          sourceIndexes[targetIndex] = targetIndex;
          matchedSourceItems.add(targetIndex);
        }
        const sourceItem = sourceNode.items[sourceIndexes[targetIndex]];
        if (!sourceItem || !targetItem || typeof sourceItem !== "object" || typeof targetItem !== "object") continue;
        for (const property of properties) {
          if (sourceItem[property] !== undefined) targetItem[property] = sourceItem[property];
        }
      }
    }
    header = document.toString({ lineWidth: 0 });
  } else {
    header = [
      `schema: ${NOTE_SCHEMA_VERSION}`,
      `id: ${JSON.stringify(note.id)}`,
      `type: ${JSON.stringify(note.type)}`,
      `status: ${JSON.stringify(note.status)}`,
      `title: ${JSON.stringify(note.title)}`,
      `tags: ${JSON.stringify(note.tags)}`,
      `created: ${JSON.stringify(note.created)}`,
      `updated: ${JSON.stringify(note.updated)}`,
    ].join("\n");
  }
  const raw = `---\n${header}${header.endsWith("\n") ? "" : "\n"}---\n${note.body}`;
  if (Buffer.byteLength(raw) > MAX_MEMORY_NOTE_BYTES) fail("INVALID_INPUT", "Memory note is too large");
  return raw;
}

function publicMetadata(note, relativePath) {
  return {
    schema: note.schema,
    id: note.id,
    type: note.type,
    status: note.status,
    title: note.title,
    tags: [...note.tags],
    created: note.created,
    updated: note.updated,
    revision: note.revision,
    relativePath,
  };
}

function publicNote(note, relativePath) {
  return { ...publicMetadata(note, relativePath), body: note.body };
}

async function assertDirectory(path, code) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return false;
    fail(code, "Memory storage is unavailable");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(code, "Memory storage entry is unsafe");
  return true;
}

async function assertRegularFile(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return false;
    fail("IO_ERROR", "Memory storage is unavailable");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("UNSAFE_ENTRY", "Memory storage entry is unsafe");
  if (stat.size > MAX_MEMORY_NOTE_BYTES) fail("MALFORMED_NOTE", "Memory note is malformed");
  return true;
}

export function createMarkdownMemoryStore(options) {
  if (!options || typeof options.root !== "string" || options.root.trim() === "") {
    fail("INVALID_INPUT", "Memory directory is required");
  }
  const root = resolve(options.root);
  const forbiddenRoots = (options.forbiddenRoots ?? []).map((path) => resolve(path));
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  assertOutsideForbidden(root, forbiddenRoots);

  async function prepareRoot(create) {
    let exists = await assertDirectory(root, "UNSAFE_VAULT");
    if (!exists && create) {
      await assertSafeCreationParent(root, forbiddenRoots);
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
      } catch {
        fail("IO_ERROR", "Memory storage is unavailable");
      }
      exists = await assertDirectory(root, "UNSAFE_VAULT");
      if (!exists) fail("IO_ERROR", "Memory storage is unavailable");
      await chmod(root, 0o700);
    }
    if (!exists) return false;
    let canonical;
    try {
      canonical = await realpath(root);
    } catch {
      fail("IO_ERROR", "Memory storage is unavailable");
    }
    assertOutsideForbidden(canonical, await canonicalizeRoots(forbiddenRoots));
    return true;
  }

  async function prepareTypeDirectory(type, create) {
    const folder = MEMORY_TYPE_FOLDERS[type];
    const path = join(root, folder);
    let exists = await assertDirectory(path, "UNSAFE_ENTRY");
    if (!exists && create) {
      try {
        await mkdir(path, { mode: 0o700 });
        await chmod(path, 0o700);
      } catch (error) {
        if (!isMissing(error)) fail("IO_ERROR", "Memory storage is unavailable");
        fail("UNSAFE_ENTRY", "Memory storage entry is unsafe");
      }
      exists = true;
    }
    return exists ? path : null;
  }

  async function locate(id) {
    validateId(id);
    if (!(await prepareRoot(false))) fail("NOT_FOUND", "Memory was not found");
    const matches = [];
    for (const type of MEMORY_TYPES) {
      const directory = await prepareTypeDirectory(type, false);
      if (!directory) continue;
      const path = join(directory, `${id}.md`);
      if (await assertRegularFile(path)) matches.push({ type, path, relativePath: join(MEMORY_TYPE_FOLDERS[type], `${id}.md`) });
    }
    if (matches.length === 0) fail("NOT_FOUND", "Memory was not found");
    if (matches.length > 1) fail("DUPLICATE_ID", "Memory id is duplicated");
    return matches[0];
  }

  async function readLocated(location) {
    let raw;
    try {
      raw = await readFile(location.path, "utf8");
    } catch {
      fail("IO_ERROR", "Memory storage is unavailable");
    }
    return { raw, note: parseMarkdownMemoryNote(raw, { id: location.relativePath.slice(-39, -3), type: location.type }) };
  }

  async function writeTemp(directory, id, raw) {
    const tempPath = join(directory, `.${id}.${nodeRandomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(raw, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      return tempPath;
    } catch {
      if (handle) await handle.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      fail("IO_ERROR", "Memory storage is unavailable");
    }
  }

  async function deleteWithLocation({ id, ifRevision, confirmId } = {}) {
    validateId(id);
    if (confirmId !== id) fail("CONFIRMATION_REQUIRED", "Forgetting requires confirmation");
    if (typeof ifRevision !== "string") fail("INVALID_INPUT", "Memory revision is required");
    const location = await locate(id);
    const { note } = await readLocated(location);
    if (note.revision !== ifRevision) fail("REVISION_CONFLICT", "Memory changed since it was read");
    try {
      await unlink(location.path);
    } catch {
      fail("IO_ERROR", "Memory storage is unavailable");
    }
    return { id, deleted: true, relativePath: location.relativePath };
  }

  return {
    /** Reject a symlinked or forbidden vault root; false when it does not exist yet. */
    async verifyRoot() {
      return prepareRoot(false);
    },

    async add(request) {
      const type = validateType(request?.type);
      const status = validateStatus(Object.hasOwn(request ?? {}, "status") ? request.status : "active");
      const title = validateTitle(request?.title);
      const tags = validateTags(request?.tags);
      const body = validateBody(request?.body ?? "");
      const id = validateId(randomUUID());
      const timestamp = now().toISOString();
      await prepareRoot(true);
      const directory = await prepareTypeDirectory(type, true);
      const relativePath = join(MEMORY_TYPE_FOLDERS[type], `${id}.md`);
      const destination = join(root, relativePath);
      if (await assertRegularFile(destination)) fail("DUPLICATE_ID", "Memory id is duplicated");
      const raw = renderNote({ schema: NOTE_SCHEMA_VERSION, id, type, status, title, tags, created: timestamp, updated: timestamp, body });
      const tempPath = await writeTemp(directory, id, raw);
      try {
        await link(tempPath, destination);
        await unlink(tempPath);
      } catch {
        await unlink(tempPath).catch(() => {});
        fail("DUPLICATE_ID", "Memory id is duplicated");
      }
      const note = parseMarkdownMemoryNote(raw, { id, type });
      return publicMetadata(note, relativePath);
    },

    async read({ id } = {}) {
      const location = await locate(id);
      const { note } = await readLocated(location);
      return publicNote(note, location.relativePath);
    },

    async addHappening({ id, ifRevision, date, text } = {}) {
      validateId(id);
      if (typeof ifRevision !== "string") fail("INVALID_INPUT", "Memory revision is required");
      validateHappeningDate(date);
      validateHappeningText(text);
      const location = await locate(id);
      const { note } = await readLocated(location);
      if (note.revision !== ifRevision) fail("REVISION_CONFLICT", "Memory changed since it was read");
      const updated = {
        ...note,
        body: appendHappening(note.body, { date, text }),
        updated: now().toISOString(),
      };
      const raw = renderNote(updated);
      const tempPath = await writeTemp(dirname(location.path), id, raw);
      try {
        const currentRaw = await readFile(location.path, "utf8");
        if (digest(currentRaw) !== ifRevision) fail("REVISION_CONFLICT", "Memory changed since it was read");
        await rename(tempPath, location.path);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        if (error instanceof MemoryError) throw error;
        fail("IO_ERROR", "Memory storage is unavailable");
      }
      const parsed = parseMarkdownMemoryNote(raw, { id, type: location.type });
      return {
        ...publicNote(parsed, location.relativePath),
        happening: { date, text },
      };
    },

    async update({ id, ifRevision, patch } = {}) {
      if (typeof ifRevision !== "string" || !patch || typeof patch !== "object" || Array.isArray(patch)) {
        fail("INVALID_INPUT", "Memory update is invalid");
      }
      const allowed = new Set(["status", "title", "tags", "body"]);
      if (Object.keys(patch).some((key) => !allowed.has(key))) fail("INVALID_INPUT", "Memory update is invalid");
      const location = await locate(id);
      const { note } = await readLocated(location);
      if (note.revision !== ifRevision) fail("REVISION_CONFLICT", "Memory changed since it was read");
      const updated = {
        ...note,
        status: Object.hasOwn(patch, "status") ? validateStatus(patch.status) : note.status,
        title: Object.hasOwn(patch, "title") ? validateTitle(patch.title) : note.title,
        tags: Object.hasOwn(patch, "tags") ? validateTags(patch.tags) : note.tags,
        body: Object.hasOwn(patch, "body") ? validateBody(patch.body) : note.body,
        updated: now().toISOString(),
      };
      const raw = renderNote(updated);
      const tempPath = await writeTemp(dirname(location.path), id, raw);
      try {
        const currentRaw = await readFile(location.path, "utf8");
        if (digest(currentRaw) !== ifRevision) fail("REVISION_CONFLICT", "Memory changed since it was read");
        await rename(tempPath, location.path);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        if (error instanceof MemoryError) throw error;
        fail("IO_ERROR", "Memory storage is unavailable");
      }
      const parsed = parseMarkdownMemoryNote(raw, { id, type: location.type });
      return publicNote(parsed, location.relativePath);
    },

    async delete(request) {
      const { id, deleted } = await deleteWithLocation(request);
      return { id, deleted };
    },

    deleteWithLocation,

    async list({ types = MEMORY_TYPES, statuses = ["active"] } = {}) {
      if (!Array.isArray(types)) fail("INVALID_INPUT", "Memory types are invalid");
      const selected = types.map(validateType);
      const selectedStatuses = validateStatuses(statuses);
      if (!(await prepareRoot(false))) return [];
      const results = [];
      const seen = new Set();
      for (const type of selected) {
        const directory = await prepareTypeDirectory(type, false);
        if (!directory) continue;
        let names;
        try {
          names = await readdir(directory);
          names.sort();
        } catch {
          fail("IO_ERROR", "Memory storage is unavailable");
        }
        for (const name of names) {
          if (!MEMORY_ID_PATTERN.test(name.slice(0, -3)) || !name.endsWith(".md")) continue;
          const id = name.slice(0, -3);
          if (seen.has(id)) fail("DUPLICATE_ID", "Memory id is duplicated");
          const path = join(directory, name);
          if (!(await assertRegularFile(path))) continue;
          const raw = await readFile(path, "utf8").catch(() => fail("IO_ERROR", "Memory storage is unavailable"));
          const note = parseMarkdownMemoryNote(raw, { id, type });
          seen.add(id);
          if (!selectedStatuses.includes(note.status)) continue;
          results.push(publicMetadata(note, join(MEMORY_TYPE_FOLDERS[type], name)));
        }
      }
      results.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
      return results;
    },
  };
}
