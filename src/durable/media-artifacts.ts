/** Immutable private media artifacts for admitted Telegram sources.
 * A ref is plain JSON that travels in the source envelope, so it takes part in source identity and replay.
 * Bytes live in a private directory keyed by the source, each file read-only and named by its SHA-256.
 * Refs never carry paths. Every read re-derives the path and re-verifies type, size and hash.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { JsonValue } from '@earendil-works/chord';

export type MediaArtifactRef = {
  id: string; sourceKey: string; index: number; sha256: string; size: number;
  kind: string; name: string; image: boolean; mimeType?: string;
};
export type MediaArtifactCode = 'invalid_ref' | 'missing' | 'corrupt' | 'too_large' | 'quota' | 'unsafe_source';
export class MediaArtifactError extends Error {
  readonly code: MediaArtifactCode;
  constructor(code: MediaArtifactCode, message: string) { super(message); this.name = 'MediaArtifactError'; this.code = code; }
}
export type MediaArtifactLimits = { maxFileBytes: number; maxSourceBytes: number; maxTotalBytes: number; maxFilesPerSource: number };
export const DEFAULT_MEDIA_ARTIFACT_LIMITS: MediaArtifactLimits = { maxFileBytes: 20 * 1024 * 1024, maxSourceBytes: 50 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxFilesPerSource: 10 };
export type MediaArtifactInput =
  | { bytes: Uint8Array }
  /** A regular file the fork downloaded into its temp directory. It is copied, never linked or adopted. */
  | { path: string };
export type MediaArtifactMeta = { kind: string; name: string; image: boolean; mimeType?: string };

const sourceDir = (sourceKey: string) => createHash('sha256').update(sourceKey).digest('hex').slice(0, 32);
const fileName = (index: number, sha256: string) => `${index}-${sha256}`;
const HEX64 = /^[a-f0-9]{64}$/;

export function parseMediaArtifactRef(value: unknown): MediaArtifactRef {
  const bad = (): never => { throw new MediaArtifactError('invalid_ref', 'Invalid media artifact reference.'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad();
  const r = value as Record<string, unknown>;
  const allowed = ['id', 'sourceKey', 'index', 'sha256', 'size', 'kind', 'name', 'image', 'mimeType'];
  if (Object.keys(r).some(key => !allowed.includes(key))) return bad();
  if (typeof r.sourceKey !== 'string' || r.sourceKey.length === 0 || r.sourceKey.length > 512 || typeof r.sha256 !== 'string' || !HEX64.test(r.sha256)
    || !Number.isSafeInteger(r.index) || (r.index as number) < 0 || (r.index as number) > 63 || !Number.isSafeInteger(r.size) || (r.size as number) < 0
    || typeof r.kind !== 'string' || r.kind.length > 32 || typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 200 || typeof r.image !== 'boolean'
    || (r.mimeType !== undefined && (typeof r.mimeType !== 'string' || r.mimeType.length > 128))) return bad();
  const ref = r as unknown as MediaArtifactRef;
  if (r.id !== `${sourceDir(ref.sourceKey)}-${ref.index}-${ref.sha256.slice(0, 16)}`) return bad();
  return { id: ref.id, sourceKey: ref.sourceKey, index: ref.index, sha256: ref.sha256, size: ref.size, kind: ref.kind, name: ref.name, image: ref.image, ...(ref.mimeType === undefined ? {} : { mimeType: ref.mimeType }) };
}

export function createMediaArtifactStore(options: { root: string; limits?: Partial<MediaArtifactLimits>; now?: () => number }) {
  const limits = { ...DEFAULT_MEDIA_ARTIFACT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const dirOf = (sourceKey: string) => join(options.root, sourceDir(sourceKey));
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const ours = (info: { uid: number }) => uid === undefined || info.uid === uid;
  const ensureRoot = async () => {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const info = await lstat(options.root);
    if (!info.isDirectory() || info.isSymbolicLink() || !ours(info) || (info.mode & 0o077) !== 0) throw new MediaArtifactError('corrupt', 'Media artifact root is not private.');
  };
  /** A source directory must be a real directory owned by this user and closed to others. It is never a link. */
  async function checkedDir(dir: string): Promise<void> {
    const info = await lstat(dir).catch(() => undefined);
    if (!info) throw new MediaArtifactError('missing', 'Media is unavailable.');
    if (!info.isDirectory() || info.isSymbolicLink() || !ours(info) || (info.mode & 0o077) !== 0) throw new MediaArtifactError('corrupt', 'Media artifact is not intact.');
  }

  async function usage(dir?: string): Promise<number> {
    let total = 0;
    const dirs = dir ? [dir] : (await readdir(options.root).catch(() => [])).map(name => join(options.root, name));
    for (const entry of dirs) {
      const directory = await lstat(entry).catch(() => undefined);
      if (!directory?.isDirectory() || directory.isSymbolicLink() || !ours(directory)) continue;
      for (const name of await readdir(entry).catch(() => [])) {
        const info = await lstat(join(entry, name)).catch(() => undefined);
        if (info?.isFile()) total += info.size;
      }
    }
    return total;
  }

  async function readSource(input: MediaArtifactInput): Promise<{ hash: string; size: number; close: () => Promise<void>; tmpWrite: (handle: Awaited<ReturnType<typeof open>>) => Promise<void> }> {
    if ('bytes' in input) {
      if (input.bytes.byteLength > limits.maxFileBytes) throw new MediaArtifactError('too_large', 'The file is larger than the artifact limit.');
      return { hash: createHash('sha256').update(input.bytes).digest('hex'), size: input.bytes.byteLength, close: async () => undefined, tmpWrite: async handle => { await handle.writeFile(input.bytes); } };
    }
    const info = await lstat(input.path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) throw new MediaArtifactError('unsafe_source', 'The source is not a regular file.');
    if (info.size > limits.maxFileBytes) throw new MediaArtifactError('too_large', 'The file is larger than the artifact limit.');
    const hash = createHash('sha256');
    const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== info.size) throw new MediaArtifactError('unsafe_source', 'The source changed while it was opened.');
      let size = 0;
      const chunk = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > limits.maxFileBytes) throw new MediaArtifactError('too_large', 'The file is larger than the artifact limit.');
        hash.update(chunk.subarray(0, bytesRead));
      }
      return { hash: hash.digest('hex'), size, close: () => handle.close(), tmpWrite: async target => {
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          if (position > size) throw new MediaArtifactError('unsafe_source', 'The source changed while it was copied.');
          await target.write(chunk, 0, bytesRead);
        }
        if (position !== size) throw new MediaArtifactError('unsafe_source', 'The source changed while it was copied.');
      } };
    } catch (error) { await handle.close(); throw error; }
  }

  async function verify(value: unknown, keep: boolean): Promise<{ ref: MediaArtifactRef; path: string; bytes?: Buffer }> {
    const ref = parseMediaArtifactRef(value);
    // Canonical root so a symlinked state directory never yields a path another tool would resolve differently.
    const selectedRoot = await lstat(options.root).catch(() => undefined);
    if (!selectedRoot) throw new MediaArtifactError('missing', 'Media is unavailable.');
    if (!selectedRoot.isDirectory() || selectedRoot.isSymbolicLink() || !ours(selectedRoot) || (selectedRoot.mode & 0o077) !== 0) throw new MediaArtifactError('corrupt', 'Media artifact root is not private.');
    const root = await realpath(options.root);
    const rootInfo = await lstat(root);
    if (rootInfo.ino !== selectedRoot.ino || rootInfo.dev !== selectedRoot.dev) throw new MediaArtifactError('corrupt', 'Media artifact root changed.');
    const dir = join(root, sourceDir(ref.sourceKey));
    await checkedDir(dir);
    const path = join(dir, fileName(ref.index, ref.sha256));
    const info = await lstat(path).catch(() => undefined);
    if (!info) throw new MediaArtifactError('missing', 'Media is unavailable.');
    const intact = () => new MediaArtifactError('corrupt', 'Media artifact is not intact.');
    if (!info.isFile() || info.isSymbolicLink() || info.size !== ref.size || (info.mode & 0o7377) !== 0 || info.nlink !== 1 || !ours(info)) throw intact();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new MediaArtifactError('missing', 'Media is unavailable.'); });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1 || opened.size !== ref.size) throw intact();
      const hash = createHash('sha256'), parts: Buffer[] = [], chunk = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > ref.size) throw intact();
        hash.update(chunk.subarray(0, bytesRead));
        if (keep) parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      if (size !== ref.size || hash.digest('hex') !== ref.sha256) throw intact();
      return { ref, path, ...(keep ? { bytes: Buffer.concat(parts) } : {}) };
    } finally { await handle.close(); }
  }

  const store = {
    limits,
    /** Store one file. Idempotent for identical bytes at the same source and index; a different payload there is rejected. */
    async stage(sourceKey: string, index: number, meta: MediaArtifactMeta, input: MediaArtifactInput): Promise<MediaArtifactRef> {
      if (!Number.isSafeInteger(index) || index < 0 || index >= limits.maxFilesPerSource) throw new MediaArtifactError('quota', 'Too many files for one source.');
      await ensureRoot();
      const dir = dirOf(sourceKey);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await checkedDir(dir);
      const prepared = await readSource(input);
      let tmp: string | undefined;
      try {
        const ref: MediaArtifactRef = { id: `${sourceDir(sourceKey)}-${index}-${prepared.hash.slice(0, 16)}`, sourceKey, index, sha256: prepared.hash, size: prepared.size, kind: meta.kind, name: meta.name, image: meta.image, ...(meta.mimeType === undefined ? {} : { mimeType: meta.mimeType }) };
        parseMediaArtifactRef(ref);
        const existing = (await readdir(dir)).filter(name => name.startsWith(`${index}-`));
        if (existing.length > 0) {
          if (existing.length === 1 && existing[0] === fileName(index, prepared.hash)) { await store.open(ref); return ref; }
          throw new MediaArtifactError('corrupt', 'A different artifact already exists for this source position.');
        }
        if (await usage(dir) + prepared.size > limits.maxSourceBytes || await usage() + prepared.size > limits.maxTotalBytes) throw new MediaArtifactError('quota', 'Media artifact quota exceeded.');
        tmp = join(dir, `.tmp-${process.pid}-${now()}-${index}`);
        const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { await prepared.tmpWrite(handle); await handle.sync(); } finally { await handle.close(); }
        await chmod(tmp, 0o400);
        await rename(tmp, join(dir, fileName(index, prepared.hash)));
        tmp = undefined;
        const dirHandle = await open(dir, constants.O_RDONLY); try { await dirHandle.sync(); } finally { await dirHandle.close(); }
        await store.open(ref);
        return ref;
      } finally { await prepared.close(); if (tmp) await rm(tmp, { force: true }); }
    },
    /** Verified path for a provider that reads a file. The whole file is hashed, so no caller has to open it to trust the path.
     * The directory chain is checked for links and foreign ownership. Valid only while the artifact exists. */
    async verifiedPath(value: unknown): Promise<{ ref: MediaArtifactRef; path: string }> {
      const { ref, path } = await verify(value, false);
      return { ref, path };
    },
    /** Read and verify the bytes. Never falls back to another source. */
    async open(value: unknown): Promise<{ ref: MediaArtifactRef; bytes: Buffer }> {
      const { ref, bytes } = await verify(value, true);
      return { ref, bytes: bytes! };
    },
    /** Retire every artifact of one consumed or cancelled source. */
    async retire(sourceKey: string): Promise<void> { await rm(dirOf(sourceKey), { recursive: true, force: true }); },
    /** Remove artifacts of sources that are neither live nor retained history, and only real directories this user owns.
     * Fresh directories are kept so an in-flight admission is safe. Retained keys are never removed. */
    async sweep(liveSourceKeys: Iterable<string>, minAgeMs: number, retainedSourceKeys: Iterable<string> = []): Promise<{ removed: number }> {
      const keep = new Set([...liveSourceKeys, ...retainedSourceKeys].map(sourceDir));
      let removed = 0;
      for (const name of await readdir(options.root).catch(() => [])) {
        const dir = join(options.root, name);
        const info = await lstat(dir).catch(() => undefined);
        if (!info?.isDirectory() || info.isSymbolicLink() || !ours(info) || keep.has(name) || now() - info.mtimeMs < minAgeMs) continue;
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
      return { removed };
    },
    usage: () => usage(),
  };
  return store;
}
export type MediaArtifactStore = ReturnType<typeof createMediaArtifactStore>;

export type NativeImageLimits = { maxWidth: number; maxHeight: number; maxBytes: number };
export type NativeImageProcessor = { prepare(bytes: Uint8Array, mimeType: string, limits: NativeImageLimits): Promise<{ data: string; mimeType: string } | undefined> };
export const NATIVE_IMAGE_LIMITS: NativeImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Native user input: the prompt text plus every image ref as actual image content. A missing or corrupt artifact fails the whole input. */
export async function buildNativeUserInput(
  text: string,
  attachments: readonly JsonValue[],
  store: Pick<MediaArtifactStore, 'open'>,
  options: { images?: NativeImageProcessor; limits?: NativeImageLimits } = {},
): Promise<string | (TextContent | ImageContent)[]> {
  const limits = options.limits ?? NATIVE_IMAGE_LIMITS;
  const blocks: ImageContent[] = [];
  for (const value of attachments) {
    const { ref, bytes } = await store.open(value);
    if (!ref.image) continue;
    const mimeType = ref.mimeType ?? '';
    if (options.images) {
      const prepared = await options.images.prepare(bytes, mimeType, limits);
      if (!prepared) throw new MediaArtifactError('too_large', `Image ${ref.name} cannot be prepared for the model.`);
      blocks.push({ type: 'image', data: prepared.data, mimeType: prepared.mimeType });
      continue;
    }
    if (!INLINE_IMAGE_TYPES.has(mimeType)) throw new MediaArtifactError('invalid_ref', `Image ${ref.name} has an unsupported format.`);
    const data = bytes.toString('base64');
    if (data.length > limits.maxBytes) throw new MediaArtifactError('too_large', `Image ${ref.name} is too large for the model.`);
    blocks.push({ type: 'image', data, mimeType });
  }
  return blocks.length === 0 ? text : [{ type: 'text', text }, ...blocks];
}
