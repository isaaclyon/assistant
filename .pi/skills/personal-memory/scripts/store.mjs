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

export const MEMORY_TYPES = Object.freeze([
  "person",
  "preference",
  "event",
  "list",
  "recipe",
  "purchase",
  "reference",
]);

const TYPE_FOLDERS = Object.freeze({
  person: "people",
  preference: "preferences",
  event: "events",
  list: "lists",
  recipe: "recipes",
  purchase: "purchases",
  reference: "references",
});
const MANAGED_KEYS = new Set(["id", "type", "title", "tags", "created", "updated"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_NOTE_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;

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

function validateId(id) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    fail("INVALID_ID", "Memory id is invalid");
  }
  return id;
}

function validateType(type) {
  if (!MEMORY_TYPES.includes(type)) fail("INVALID_INPUT", "Memory type is invalid");
  return type;
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

function parseManagedValue(key, source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  if (key === "id") return validateId(value);
  if (key === "type") {
    try {
      return validateType(value);
    } catch {
      fail("MALFORMED_NOTE", "Memory note is malformed");
    }
  }
  if (key === "title") {
    try {
      return validateTitle(value);
    } catch {
      fail("MALFORMED_NOTE", "Memory note is malformed");
    }
  }
  if (key === "tags") {
    try {
      return validateTags(value);
    } catch {
      fail("MALFORMED_NOTE", "Memory note is malformed");
    }
  }
  return validateTimestamp(value);
}

function parseNote(raw, expected = {}) {
  if (Buffer.byteLength(raw) > MAX_NOTE_BYTES || !raw.startsWith("---\n")) {
    fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  const closing = raw.indexOf("\n---\n", 4);
  if (closing < 0) fail("MALFORMED_NOTE", "Memory note is malformed");
  const header = raw.slice(4, closing);
  const body = raw.slice(closing + 5);
  const values = {};
  const unknown = [];
  let managedContinuation = false;

  for (const match of header.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const line = match[0];
    if (line === "") continue;
    const plain = line.endsWith("\n") ? line.slice(0, -1) : line;
    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u.exec(plain);
    if (keyMatch) {
      const [, key, source] = keyMatch;
      if (MANAGED_KEYS.has(key)) {
        if (Object.hasOwn(values, key)) fail("MALFORMED_NOTE", "Memory note is malformed");
        values[key] = parseManagedValue(key, source);
        managedContinuation = true;
      } else {
        unknown.push(line);
        managedContinuation = false;
      }
      continue;
    }
    if (/^[ \t]+/u.test(plain) && managedContinuation) {
      fail("MALFORMED_NOTE", "Memory note is malformed");
    }
    unknown.push(line);
    if (plain === "" || plain.startsWith("#")) managedContinuation = false;
  }

  for (const key of MANAGED_KEYS) {
    if (!Object.hasOwn(values, key)) fail("MALFORMED_NOTE", "Memory note is malformed");
  }
  if (expected.id && values.id !== expected.id) fail("MALFORMED_NOTE", "Memory note is malformed");
  if (expected.type && values.type !== expected.type) fail("MALFORMED_NOTE", "Memory note is malformed");
  validateBody(body);
  return { ...values, body, unknownFrontmatter: unknown.join(""), revision: digest(raw) };
}

function renderNote(note) {
  const managed = [
    `id: ${JSON.stringify(note.id)}`,
    `type: ${JSON.stringify(note.type)}`,
    `title: ${JSON.stringify(note.title)}`,
    `tags: ${JSON.stringify(note.tags)}`,
    `created: ${JSON.stringify(note.created)}`,
    `updated: ${JSON.stringify(note.updated)}`,
  ].join("\n");
  let unknown = "\n";
  if (note.unknownFrontmatter) {
    unknown = `\n${note.unknownFrontmatter.replace(/^\n/u, "")}`;
    if (!note.unknownFrontmatter.endsWith("\n")) unknown += "\n";
  }
  const raw = `---\n${managed}${unknown}---\n${note.body}`;
  if (Buffer.byteLength(raw) > MAX_NOTE_BYTES) fail("INVALID_INPUT", "Memory note is too large");
  return raw;
}

function publicMetadata(note, relativePath) {
  return {
    id: note.id,
    type: note.type,
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
  if (stat.size > MAX_NOTE_BYTES) fail("MALFORMED_NOTE", "Memory note is malformed");
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
    assertOutsideForbidden(canonical, forbiddenRoots);
    return true;
  }

  async function prepareTypeDirectory(type, create) {
    const folder = TYPE_FOLDERS[type];
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
      if (await assertRegularFile(path)) matches.push({ type, path, relativePath: join(TYPE_FOLDERS[type], `${id}.md`) });
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
    return { raw, note: parseNote(raw, { id: location.relativePath.slice(-39, -3), type: location.type }) };
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

  return {
    async add(request) {
      const type = validateType(request?.type);
      const title = validateTitle(request?.title);
      const tags = validateTags(request?.tags);
      const body = validateBody(request?.body ?? "");
      const id = validateId(randomUUID());
      const timestamp = now().toISOString();
      await prepareRoot(true);
      const directory = await prepareTypeDirectory(type, true);
      const relativePath = join(TYPE_FOLDERS[type], `${id}.md`);
      const destination = join(root, relativePath);
      if (await assertRegularFile(destination)) fail("DUPLICATE_ID", "Memory id is duplicated");
      const raw = renderNote({ id, type, title, tags, created: timestamp, updated: timestamp, body, unknownFrontmatter: "" });
      const tempPath = await writeTemp(directory, id, raw);
      try {
        await link(tempPath, destination);
        await unlink(tempPath);
      } catch {
        await unlink(tempPath).catch(() => {});
        fail("DUPLICATE_ID", "Memory id is duplicated");
      }
      const note = parseNote(raw, { id, type });
      return publicMetadata(note, relativePath);
    },

    async read({ id } = {}) {
      const location = await locate(id);
      const { note } = await readLocated(location);
      return publicNote(note, location.relativePath);
    },

    async update({ id, ifRevision, patch } = {}) {
      if (typeof ifRevision !== "string" || !patch || typeof patch !== "object" || Array.isArray(patch)) {
        fail("INVALID_INPUT", "Memory update is invalid");
      }
      const allowed = new Set(["title", "tags", "body"]);
      if (Object.keys(patch).some((key) => !allowed.has(key))) fail("INVALID_INPUT", "Memory update is invalid");
      const location = await locate(id);
      const { note } = await readLocated(location);
      if (note.revision !== ifRevision) fail("REVISION_CONFLICT", "Memory changed since it was read");
      const updated = {
        ...note,
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
      const parsed = parseNote(raw, { id, type: location.type });
      return publicNote(parsed, location.relativePath);
    },

    async delete({ id, ifRevision, confirmId } = {}) {
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
      return { id, deleted: true };
    },

    async list({ types = MEMORY_TYPES } = {}) {
      if (!Array.isArray(types)) fail("INVALID_INPUT", "Memory types are invalid");
      const selected = types.map(validateType);
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
          if (!UUID_PATTERN.test(name.slice(0, -3)) || !name.endsWith(".md")) continue;
          const id = name.slice(0, -3);
          if (seen.has(id)) fail("DUPLICATE_ID", "Memory id is duplicated");
          const path = join(directory, name);
          if (!(await assertRegularFile(path))) continue;
          const raw = await readFile(path, "utf8").catch(() => fail("IO_ERROR", "Memory storage is unavailable"));
          const note = parseNote(raw, { id, type });
          seen.add(id);
          results.push(publicMetadata(note, join(TYPE_FOLDERS[type], name)));
        }
      }
      results.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
      return results;
    },
  };
}
