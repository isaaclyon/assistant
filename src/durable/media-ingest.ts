/** Inbound Telegram media admission.
 * A media message becomes one source envelope whose attachments are immutable artifact refs.
 * Album members are journaled before the update offset advances, so a crash replays every member.
 * Failures are explicit: a retryable failure keeps the source unacknowledged until the attempt limit,
 * a permanent one returns a visible rejection. Nothing is dropped and no partial input is built.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue } from '@earendil-works/chord';
import {
  createTelegramNativeMediaGroups, decodeTelegramNativeMedia, formatTelegramNativeMediaPrompt, transcribeTelegramNativeVoice,
  TelegramNativeVoiceError, TELEGRAM_NATIVE_MEDIA_LIMITS,
  type TelegramNativeMediaAnnotation, type TelegramNativeMediaFile, type TelegramNativeMediaInput, type TelegramNativeMediaMessage, type TelegramNativeVoiceProvider,
} from '@llblab/pi-telegram/durable';
import { normalize, sourceKey, type InputAdapter, type SourceActor, type SourceEnvelope } from './ingress.js';
import { buildNativeUserInput, MediaArtifactError, parseMediaArtifactRef, type MediaArtifactRef, type MediaArtifactStore, type NativeImageProcessor } from './media-artifacts.js';
import { downloadTelegramFile, MediaTransportError, type MediaPort } from './media-transport.js';

export type MediaIngestIdentity = { instance: string; principal: string; bot: string };
export type MediaIngestResult =
  | { type: 'none' }
  | { type: 'pending'; dueAt: number }
  | { type: 'input'; envelope: SourceEnvelope; messageIds: number[] }
  | { type: 'rejected'; reason: string; messageIds: number[] };

export type JournalRecord = { updateId: number; message: TelegramNativeMediaMessage; actor?: SourceActor };
/** The journal holds an unreadable, foreign or invalid record. Recovery stops: an accepted album must never be dropped silently. */
export class MediaJournalError extends Error { constructor(message: string) { super(message); this.name = 'MediaJournalError'; } }

const JOURNAL_MAX_RECORD_BYTES = 128 * 1024;
const JOURNAL_MAX_RECORDS = 256;
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const exactKeys = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Strict structural validation of a record read from disk. Throws `MediaJournalError`. */
export function parseJournalRecord(value: unknown): JournalRecord {
  const bad = (): never => { throw new MediaJournalError('Invalid album journal record.'); };
  const object = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : bad());
  const r = object(value);
  if (!exactKeys(r, ['updateId', 'message', 'actor']) || !isInt(r.updateId) || (r.updateId as number) < 0) bad();
  const m = object(r.message);
  if (!exactKeys(m, ['messageId', 'date', 'chatId', 'mediaGroupId', 'text', 'files']) || !isInt(m.messageId) || (m.messageId as number) <= 0 || !isInt(m.date) || !isInt(m.chatId)
    || typeof m.mediaGroupId !== 'string' || m.mediaGroupId.length === 0 || m.mediaGroupId.length > 256
    || typeof m.text !== 'string' || m.text.length > TELEGRAM_NATIVE_MEDIA_LIMITS.maxTextChars || !Array.isArray(m.files) || m.files.length > TELEGRAM_NATIVE_MEDIA_LIMITS.maxFilesPerMessage) bad();
  const files = (m.files as unknown[]).map(item => {
    const f = object(item);
    if (!exactKeys(f, ['kind', 'fileId', 'fileUniqueId', 'name', 'mimeType', 'declaredSize', 'image', 'messageId']) || typeof f.kind !== 'string' || f.kind.length > 32
      || typeof f.fileId !== 'string' || f.fileId.length === 0 || f.fileId.length > 512 || typeof f.name !== 'string' || f.name.length === 0 || f.name.length > 200 || typeof f.image !== 'boolean' || f.messageId !== m.messageId
      || (f.fileUniqueId !== undefined && (typeof f.fileUniqueId !== 'string' || f.fileUniqueId.length > 512))
      || (f.mimeType !== undefined && (typeof f.mimeType !== 'string' || f.mimeType.length > 128))
      || (f.declaredSize !== undefined && (!isInt(f.declaredSize) || (f.declaredSize as number) < 0))) bad();
    return f as unknown as TelegramNativeMediaFile;
  });
  let actor: SourceActor | undefined;
  if (r.actor !== undefined) {
    const a = object(r.actor);
    if (!exactKeys(a, ['id', 'label']) || !isInt(a.id) || typeof a.label !== 'string' || !/^[A-Za-z]{1,32}$/.test(a.label)) bad();
    actor = { id: a.id as number, label: a.label as string };
  }
  const message: TelegramNativeMediaMessage = { messageId: m.messageId as number, date: m.date as number, chatId: m.chatId as number, mediaGroupId: m.mediaGroupId as string, text: m.text as string, files };
  return { updateId: r.updateId as number, message, ...(actor ? { actor } : {}) };
}

/** One fsynced file per pending album member, in a private directory owned by this user.
 * Removed only after the album is accepted or visibly rejected. `list` fails closed on any unreadable,
 * foreign, linked, oversized or invalid entry, and on too many records. */
export function createAlbumJournal(dir: string) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const name = (message: TelegramNativeMediaMessage) => `${createHash('sha256').update(`${message.chatId}:${message.mediaGroupId ?? ''}`).digest('hex').slice(0, 24)}-${message.messageId}.json`;
  const syncDir = async () => { const directory = await open(dir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } };
  async function checkDir(create: boolean): Promise<boolean> {
    if (create) { await mkdir(dir, { recursive: true, mode: 0o700 }); if (!(await lstat(dir)).isSymbolicLink()) await chmod(dir, 0o700); }
    const info = await lstat(dir).catch(() => undefined);
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) throw new MediaJournalError('Album journal directory is not private.');
    return true;
  }
  return {
    async put(record: JournalRecord): Promise<void> {
      parseJournalRecord(record);
      await checkDir(true);
      const final = join(dir, name(record.message)), tmp = `${final}.tmp`;
      await rm(tmp, { force: true });
      const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, final);
      await syncDir();
    },
    async remove(messages: readonly TelegramNativeMediaMessage[]): Promise<void> {
      if (messages.length === 0 || !await checkDir(false)) return;
      for (const message of messages) await rm(join(dir, name(message)), { force: true });
      await syncDir();
    },
    async list(): Promise<JournalRecord[]> {
      if (!await checkDir(false)) return [];
      const files = (await readdir(dir)).sort();
      const records: JournalRecord[] = [];
      for (const file of files) {
        const path = join(dir, file);
        if (file.endsWith('.tmp')) {
          // A temporary file was never renamed into place, so it was never acknowledged.
          const info = await lstat(path);
          if (!info.isFile() || (uid !== undefined && info.uid !== uid)) throw new MediaJournalError('Album journal contains a foreign entry.');
          await rm(path, { force: true });
          continue;
        }
        if (!file.endsWith('.json') || records.length >= JOURNAL_MAX_RECORDS) throw new MediaJournalError('Album journal contains an unexpected entry or too many records.');
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0 || info.size > JOURNAL_MAX_RECORD_BYTES) throw new MediaJournalError('Album journal record is not a private regular file.');
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let text: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== info.ino || opened.size > JOURNAL_MAX_RECORD_BYTES) throw new MediaJournalError('Album journal record changed while it was read.');
          text = (await handle.readFile()).toString('utf8');
        } finally { await handle.close(); }
        let record: JournalRecord;
        try { record = parseJournalRecord(JSON.parse(text)); }
        catch (error) { throw error instanceof MediaJournalError ? error : new MediaJournalError('Album journal record is not valid JSON.'); }
        if (file !== name(record.message)) throw new MediaJournalError('Album journal record name does not match its content.');
        records.push(record);
      }
      return records;
    },
  };
}
export type AlbumJournal = ReturnType<typeof createAlbumJournal>;

export type MediaIngestOptions = {
  identity: MediaIngestIdentity;
  port: MediaPort;
  store: MediaArtifactStore;
  journal: AlbumJournal;
  /** Absent for the legacy parity: a voice message is refused visibly. */
  voice?: TelegramNativeVoiceProvider;
  /** Prepare model input before durable acceptance, so corrupt or unsupported images are refused visibly. */
  validateInput?: (envelope: SourceEnvelope) => Promise<void>;
  /** Attempts for one retryable source before it is rejected visibly. */
  maxAttempts?: number;
  now?: () => number;
  quietMs?: number;
  /** Recovery check for a journaled record: return false for an unauthorized chat or actor. Recovery then fails closed. */
  authorize?: (record: { chatId: number; actor?: SourceActor }) => boolean;
};

const PERMANENT_STAGE = new Set(['too_large', 'quota', 'unsafe_source', 'invalid_ref']);

export function createMediaIngest(options: MediaIngestOptions) {
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? 3;
  const groups = createTelegramNativeMediaGroups({ ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }) });
  const members = new Map<number, JournalRecord>();
  const attempts = new Map<string, number>();
  const limits = TELEGRAM_NATIVE_MEDIA_LIMITS;

  async function ingest(input: TelegramNativeMediaInput, actor?: SourceActor): Promise<{ envelope: SourceEnvelope } | { reason: string }> {
    const provisional = { ...options.identity, chatId: input.chatId, messageIds: input.messageIds, originalAt: input.date * 1000, content: '', ...(actor ? { actor } : {}) };
    const key = sourceKey(normalize(provisional));
    const refs: MediaArtifactRef[] = [];
    const annotations: TelegramNativeMediaAnnotation[] = [];
    for (const [index, file] of input.files.entries()) {
      if (file.kind === 'voice' && !options.voice) return { reason: 'Voice messages are not supported because no transcription provider is configured.' };
      let bytes: Uint8Array;
      try { bytes = await downloadTelegramFile(options.port, file.fileId, limits.maxFileBytes); }
      catch (error) {
        if (error instanceof MediaTransportError && !error.retryable) return { reason: `Telegram media could not be fetched: ${error.message}` };
        throw error;
      }
      let ref: MediaArtifactRef;
      try { ref = await options.store.stage(key, index, { kind: file.kind, name: file.name, image: file.image, ...(file.mimeType ? { mimeType: file.mimeType } : {}) }, { bytes }); }
      catch (error) {
        if (error instanceof MediaArtifactError && PERMANENT_STAGE.has(error.code)) return { reason: `Telegram media was refused: ${error.message}` };
        throw error;
      }
      refs.push(ref);
      let transcript: string | undefined;
      if (file.kind === 'voice') {
        const { path } = await options.store.verifiedPath(ref);
        try { transcript = await transcribeTelegramNativeVoice({ path, fileName: file.name, ...(file.mimeType ? { mimeType: file.mimeType } : {}), kind: 'voice' }, { provider: options.voice! }); }
        catch (error) {
          if (error instanceof TelegramNativeVoiceError && error.code !== 'timeout') return { reason: error.message };
          throw error;
        }
      }
      annotations.push({ artifactId: ref.id, ...(file.image ? { imageAttached: true } : {}), ...(transcript === undefined ? {} : { transcript }) });
    }
    const content = formatTelegramNativeMediaPrompt(input, annotations);
    const envelope = normalize({ ...provisional, content, attachments: refs as unknown as JsonValue[] });
    try { await options.validateInput?.(envelope); }
    catch (error) {
      if (error instanceof MediaArtifactError) return { reason: `Telegram media was refused: ${error.message}` };
      throw error;
    }
    return { envelope };
  }

  /** Run one ingest with bounded retries. A retryable failure rethrows so the caller leaves the offset unacknowledged. */
  async function attempt(input: TelegramNativeMediaInput, actor: SourceActor | undefined): Promise<MediaIngestResult> {
    const id = input.messageIds.join(',');
    try {
      const result = await ingest(input, actor);
      attempts.delete(id);
      return 'envelope' in result ? { type: 'input', envelope: result.envelope, messageIds: input.messageIds } : { type: 'rejected', reason: result.reason, messageIds: input.messageIds };
    } catch (error) {
      const count = (attempts.get(id) ?? 0) + 1;
      if (count >= maxAttempts) { attempts.delete(id); return { type: 'rejected', reason: 'Telegram media could not be processed after several attempts.', messageIds: input.messageIds }; }
      attempts.set(id, count);
      throw error;
    }
  }

  const groupKey = (message: TelegramNativeMediaMessage) => `${message.chatId}:${message.mediaGroupId ?? ''}`;
  const canon = (value: unknown): string => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([x], [y]) => (x < y ? -1 : 1))) : item));
  const identityOf = (record: JournalRecord) => canon({ message: record.message, actor: record.actor ?? null });
  const actorKey = (record: JournalRecord) => (record.actor ? `${record.actor.id}:${record.actor.label}` : '');
  /** Albums refused for a conflict stay refused for a while, so a late member cannot start a partial album. */
  const refused = new Map<string, number>();
  const REFUSE_MS = 10 * 60_000;

  const forget = async (ids: readonly number[]) => {
    const records = ids.map(id => members.get(id)).filter((value): value is JournalRecord => value !== undefined);
    for (const id of ids) members.delete(id);
    await options.journal.remove(records.map(record => record.message));
  };
  /** Drop every pending member of one album. The assembler may still emit it; `collect` skips inputs with missing members. */
  async function voidGroup(key: string, extra: readonly number[] = []): Promise<number[]> {
    const ids = new Set(extra);
    for (const record of members.values()) if (groupKey(record.message) === key) ids.add(record.message.messageId);
    refused.set(key, now() + REFUSE_MS);
    await forget([...ids]);
    return [...ids].sort((x, y) => x - y);
  }
  /** One actor for the whole album. `undefined` means a member is missing or the actors differ. */
  function albumActor(input: TelegramNativeMediaInput): { actor?: SourceActor } | undefined {
    const records = input.messageIds.map(id => members.get(id));
    if (records.some(record => record === undefined)) return undefined;
    const all = records as JournalRecord[];
    if (new Set(all.map(actorKey)).size !== 1) return undefined;
    return all[0]!.actor ? { actor: all[0]!.actor } : {};
  }
  const mixedReason = 'This album was refused because its messages do not share one sender.';

  return {
    /** Call from the update hook for a private-chat message after authorization. `none` means use the text path.
     * An album member is journaled before this returns, so the caller may acknowledge its offset after `pending`.
     * A conflicting replay (same message id, different content or sender) or a member from another sender
     * refuses the whole album visibly. */
    async receive(raw: unknown, context: { updateId: number; actor?: SourceActor }): Promise<MediaIngestResult> {
      const decoded = decodeTelegramNativeMedia(raw);
      if (decoded.type === 'none') return { type: 'none' };
      if (decoded.type === 'rejected') return { type: 'rejected', reason: decoded.reason, messageIds: [] };
      const record: JournalRecord = { updateId: context.updateId, message: decoded.message, ...(context.actor ? { actor: context.actor } : {}) };
      if (decoded.message.mediaGroupId === undefined) {
        // An ungrouped message needs no journal: its update stays unacknowledged until the caller accepts the envelope.
        const single = groups.add(decoded.message, now());
        if (single.type === 'rejected') return { type: 'rejected', reason: single.reason, messageIds: single.messageIds };
        if (single.type !== 'ready') throw new Error('Unexpected pending single message');
        members.set(decoded.message.messageId, record);
        try { return await attempt(single.input, context.actor); } finally { members.delete(decoded.message.messageId); }
      }
      const key = groupKey(decoded.message);
      const until = refused.get(key);
      if (until !== undefined && until > now()) return { type: 'rejected', reason: 'This album was refused.', messageIds: [decoded.message.messageId] };
      const existing = members.get(decoded.message.messageId);
      if (existing && identityOf(existing) !== identityOf(record)) {
        const ids = await voidGroup(key, [decoded.message.messageId]);
        if (groupKey(existing.message) !== key) await voidGroup(groupKey(existing.message));
        return { type: 'rejected', reason: 'This album was refused because a message arrived twice with different content.', messageIds: ids };
      }
      for (const other of members.values()) {
        if (groupKey(other.message) === key && actorKey(other) !== actorKey(record)) return { type: 'rejected', reason: mixedReason, messageIds: await voidGroup(key, [decoded.message.messageId]) };
      }
      // Journal first: the transport advances its offset as soon as this call returns.
      if (!existing) await options.journal.put(record);
      members.set(decoded.message.messageId, existing ?? record);
      const added = groups.add(decoded.message, now());
      if (added.type === 'rejected') { await forget(added.messageIds); return { type: 'rejected', reason: added.reason, messageIds: added.messageIds }; }
      if (added.type === 'ready') throw new Error('Unexpected ready album member');
      return { type: 'pending', dueAt: added.dueAt };
    },
    /** Re-add journaled members after a restart. Returns the next due time.
     * Throws `MediaJournalError` and adds nothing when the journal is unreadable, invalid, ambiguous or unauthorized. */
    async recover(): Promise<number | undefined> {
      const records = await options.journal.list();
      const ids = new Set<number>(), actors = new Map<string, string>();
      for (const record of records) {
        const id = record.message.messageId, key = groupKey(record.message);
        if (ids.has(id) || (actors.has(key) && actors.get(key) !== actorKey(record))) throw new MediaJournalError('Album journal is ambiguous.');
        ids.add(id); actors.set(key, actorKey(record));
        if (options.authorize && !options.authorize({ chatId: record.message.chatId, ...(record.actor ? { actor: record.actor } : {}) })) throw new MediaJournalError('Album journal record is not authorized.');
        const present = members.get(id);
        if (present && identityOf(present) !== identityOf(record)) throw new MediaJournalError('Album journal conflicts with a pending member.');
      }
      for (const record of records) { members.set(record.message.messageId, members.get(record.message.messageId) ?? record); groups.add(record.message, now()); }
      return groups.nextDueAt();
    },
    nextDueAt: () => groups.nextDueAt(),
    /** Assemble due albums. A retryable failure re-queues the album and reports the error in `failed`.
     * Returned inputs stay journaled and pending until `done`. Call `requeue` when accepting an input fails. */
    async collect(at: number = now()): Promise<{ inputs: Extract<MediaIngestResult, { type: 'input' }>[]; rejected: Extract<MediaIngestResult, { type: 'rejected' }>[]; failed: unknown[] }> {
      const due = groups.collect(at);
      const inputs: Extract<MediaIngestResult, { type: 'input' }>[] = [], rejected: Extract<MediaIngestResult, { type: 'rejected' }>[] = [], failed: unknown[] = [];
      for (const item of due.rejected) {
        if (item.messageIds.every(id => !members.has(id))) continue;
        rejected.push({ type: 'rejected', reason: item.reason, messageIds: item.messageIds }); await forget(item.messageIds);
      }
      for (const input of due.ready) {
        if (input.messageIds.every(id => !members.has(id))) continue; // refused or already finished
        const resolved = albumActor(input);
        if (!resolved) {
          const first = members.get(input.messageIds.find(id => members.has(id))!)!;
          rejected.push({ type: 'rejected', reason: mixedReason, messageIds: await voidGroup(groupKey(first.message), [...input.messageIds]) });
          continue;
        }
        try {
          const result = await attempt(input, resolved.actor);
          if (result.type === 'input') inputs.push(result);
          else if (result.type === 'rejected') { rejected.push(result); await forget(result.messageIds); }
        } catch (error) {
          failed.push(error);
          // Keep every member journaled and queue the album again after a quiet period.
          failed.push(...readd(input.messageIds, at));
        }
      }
      return { inputs, rejected, failed };
    },
    /** Put a collected album back in the queue after its acceptance failed. Members stay journaled. Throws if the queue refuses it. */
    requeue(messageIds: readonly number[], at: number = now()): void {
      const errors = readd(messageIds, at);
      if (errors.length > 0) throw errors[0];
    },
    /** Call after the envelope is durably accepted. Removes the journal records. */
    done: forget,
  };

  function readd(ids: readonly number[], at: number): Error[] {
    const errors: Error[] = [];
    for (const id of ids) {
      const record = members.get(id);
      if (!record) continue;
      const added = groups.add(record.message, at);
      if (added.type === 'rejected') errors.push(new Error(`Album member ${id} could not be queued again: ${added.reason}`));
    }
    return errors;
  }
}
export type MediaIngest = ReturnType<typeof createMediaIngest>;

/** Verify that every attachment of an accepted human source is a live artifact of that same source. */
export async function assertMediaAttachments(envelope: SourceEnvelope, store: Pick<MediaArtifactStore, 'verifiedPath'>, maxFiles = TELEGRAM_NATIVE_MEDIA_LIMITS.maxFilesPerMessage * 10): Promise<MediaArtifactRef[]> {
  const attachments = envelope.attachments ?? [];
  if (attachments.length === 0) return [];
  if (envelope.job || envelope.child || envelope.proactive === true || attachments.length > maxFiles) throw new Error('Source attachments are not allowed here');
  const key = sourceKey(normalize(envelope));
  const refs: MediaArtifactRef[] = [];
  for (const value of attachments) {
    const ref = parseMediaArtifactRef(value);
    if (ref.sourceKey !== key || refs.some(other => other.index === ref.index)) throw new Error('Source attachment does not belong to this source');
    await store.verifiedPath(ref);
    refs.push(ref);
  }
  return refs;
}

/** Admission adapter: native image blocks for images, and host-verified canonical paths for other files.
 * Paths come only from the artifact store after hash verification, never from message content.
 * The paths are read-only copies; the file and shell tools still apply their own authority to them. */
export function createNativeInputAdapter(store: MediaArtifactStore, options: { images?: NativeImageProcessor } = {}): InputAdapter {
  return async (envelope, text) => {
    const refs = await assertMediaAttachments(envelope, store);
    const lines: string[] = [];
    for (const ref of refs) {
      if (ref.image || ref.kind === 'voice') continue;
      const { path } = await store.verifiedPath(ref);
      lines.push(`- ${JSON.stringify(ref.name)} (artifact ${ref.id}): ${JSON.stringify(path)}`);
    }
    const full = lines.length === 0 ? text : `${text}\n\n[read-only host-verified file copies; temporary bytes expire seven days after the work settles]\n${lines.join('\n')}`;
    return buildNativeUserInput(full, refs as unknown as JsonValue[], store, options);
  };
}
