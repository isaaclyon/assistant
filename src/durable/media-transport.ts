/** Telegram media transfer over a raw port. No ownership logic lives here: the port enforces it per call.
 * Downloads are bounded and classified as retryable or permanent. Uploads report whether Telegram
 * definitely did not accept the file, so the host ledger never resends an uncertain effect.
 */
export type MediaPort = {
  call(method: string, body: object | FormData, signal?: AbortSignal): Promise<{ status: number; payload: any }>;
  file(filePath: string, signal?: AbortSignal): Promise<Response>;
};

export class MediaTransportError extends Error {
  /** A later identical attempt can succeed (network, rate limit, server error). */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.name = 'MediaTransportError'; this.retryable = retryable; }
}
/** Same shape the final-text ledger reads: `definitelyNotSent` true allows a retry, anything else is uncertain. */
export class MediaDeliveryError extends Error {
  readonly definitelyNotSent: boolean;
  constructor(message: string, definitelyNotSent: boolean) { super(message); this.name = 'MediaDeliveryError'; this.definitelyNotSent = definitelyNotSent; }
}

const retryableStatus = (status: number) => status === 429 || status >= 500;

export const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
const SAFE_FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
/** A Telegram file path is relative, has no empty, dot or dot-dot segment, and no encoding or query characters. */
export const isSafeTelegramFilePath = (path: unknown): path is string =>
  typeof path === 'string' && path.length <= 512 && SAFE_FILE_PATH.test(path) && path.split('/').every(part => part !== '.' && part !== '..' && !part.startsWith('.'));

/** Resolve a file id and download its bytes within `maxBytes` and `timeoutMs` for the whole transfer.
 * The deadline is enforced here even when the port ignores the signal. A timeout is retryable. */
export async function downloadTelegramFile(port: MediaPort, fileId: string, maxBytes: number, signal?: AbortSignal, timeoutMs: number = MEDIA_DOWNLOAD_TIMEOUT_MS): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const bound = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const stop = () => reject(new MediaTransportError('Telegram file transfer timed out.', true));
    if (combined.aborted) { work.catch(() => undefined); return stop(); }
    combined.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => combined.removeEventListener('abort', stop));
  });
  let meta: { status: number; payload: any };
  try { meta = await bound(port.call('getFile', { file_id: fileId }, combined)); }
  catch (error) {
    if (error instanceof MediaTransportError) throw error;
    if (typeof error === 'object' && error !== null && 'definitelyNotSent' in error) throw new MediaTransportError('Telegram is unavailable.', true);
    throw new MediaTransportError('Telegram file lookup failed.', true);
  }
  if (meta.status !== 200 || meta.payload?.ok !== true) {
    throw new MediaTransportError(retryableStatus(meta.status) || meta.payload === undefined ? 'Telegram file lookup failed.' : 'Telegram cannot provide this file.', retryableStatus(meta.status) || meta.payload === undefined);
  }
  const result = meta.payload.result;
  const path = result?.file_path;
  if (!isSafeTelegramFilePath(path)) throw new MediaTransportError('Telegram returned an invalid file path.', false);
  if (result.file_size !== undefined && (!Number.isSafeInteger(result.file_size) || result.file_size < 0 || result.file_size > maxBytes)) throw new MediaTransportError('The file is larger than the limit.', false);
  let response: Response;
  try { response = await bound(port.file(path, combined)); }
  catch (error) { throw error instanceof MediaTransportError ? error : new MediaTransportError('Telegram file download failed.', true); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new MediaTransportError('Telegram file download failed.', retryableStatus(response.status)); }
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new MediaTransportError('The file is larger than the limit.', false); }
  if (!response.body) throw new MediaTransportError('Telegram file download failed.', true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await bound(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new MediaTransportError('The file is larger than the limit.', false);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof MediaTransportError) throw error;
    throw new MediaTransportError('Telegram file download failed.', true);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export type OutboundMediaMethod = 'sendPhoto' | 'sendDocument';
/** Legacy rule: jpg, jpeg, png, webp and gif go out as photos, everything else as documents. */
export function outboundMediaMethod(fileName: string): { method: OutboundMediaMethod; field: 'photo' | 'document' } {
  return /\.(jpe?g|png|webp|gif)$/i.test(fileName) ? { method: 'sendPhoto', field: 'photo' } : { method: 'sendDocument', field: 'document' };
}

/** Upload one file to one chat. Throws `MediaDeliveryError`, or an error with `definitelyNotSent` from the port, never a partial success. */
export async function uploadTelegramMedia(
  port: MediaPort,
  target: { chatId: number; threadId?: number },
  file: { bytes: Uint8Array; name: string },
  replyToMessageId?: number,
  signal?: AbortSignal,
): Promise<{ messageId: number }> {
  const { method, field } = outboundMediaMethod(file.name);
  const form = new FormData();
  form.set('chat_id', String(target.chatId));
  if (target.threadId !== undefined) form.set('message_thread_id', String(target.threadId));
  if (replyToMessageId !== undefined) form.set('reply_parameters', JSON.stringify({ message_id: replyToMessageId }));
  form.set(field, new Blob([file.bytes as BlobPart]), file.name);
  let response: { status: number; payload: any };
  try { response = await port.call(method, form, signal); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'definitelyNotSent' in error && (error as { definitelyNotSent?: unknown }).definitelyNotSent === true) throw error;
    throw new MediaDeliveryError('Telegram acknowledgement unavailable.', false);
  }
  const id = response.payload?.result?.message_id;
  if (response.status === 200 && response.payload?.ok === true) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new MediaDeliveryError('Telegram receipt missing.', false);
    return { messageId: id };
  }
  // A JSON rejection with a client error code means Telegram did not create the message.
  const rejected = response.payload?.ok === false && response.status >= 400 && response.status < 500;
  throw new MediaDeliveryError(rejected ? `Telegram rejected the file (${response.status}).` : 'Telegram acknowledgement unavailable.', rejected);
}
