/** Outbound Telegram media: the native `telegram_attach` tool and its effect ledger.
 * Legacy protocol kept: up to 10 files per turn, sent after the final reply as one message each
 * (photo for jpg, jpeg, png, webp and gif, document otherwise), replying to the user's message, with a visible
 * "Failed to send attachment" notice per failed file. The old direct-send mode outside a turn is not offered.
 * Safety: the tool copies each file into a private immutable artifact store at call time, through a host
 * authority check, so later delivery never reads a mutable or unauthorized path. Each file is one ledger effect.
 * A crash during a send marks the file uncertain and it is never sent again automatically.
 */
import { basename } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineTool, type ConversationId } from '@earendil-works/pi-durable';
import { Bindings, context, type IngressRuntime, type Target } from './ingress.js';
import { MediaArtifactError, type MediaArtifactRef, type MediaArtifactStore } from './media-artifacts.js';
import { uploadTelegramMedia, type MediaPort } from './media-transport.js';
import { textToolResult, type NativeBundle } from './registry.js';

export const MAX_OUTBOUND_FILES_PER_TURN = 10;
const MAX_SEND_ATTEMPTS = 3;

export type OutboundFileState = 'queued' | 'sending' | 'delivered' | 'failed' | 'uncertain';
export type OutboundFile = { id: string; storeKey: string; ref: MediaArtifactRef; name: string; status: OutboundFileState; attempts: number; messageId?: number; error?: string; notice: 'none' | 'sending' | 'done' | 'unknown' };
export const MediaOutbox = defineDoc({ kind: 'bridge.media-outbox', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ items: {} as Record<string, { files: OutboundFile[] }> }) });

export type MediaSendRequest = { target: Target; replyToMessageId?: number; file: { bytes: Uint8Array; name: string }; identity: string };
export type MediaSender = (request: MediaSendRequest) => Promise<{ messageId: number }>;
export type MediaNotifier = (target: Target, text: string, replyToMessageId?: number) => Promise<unknown>;

/** Sender over a raw media port. `allowed` is the same target authority the text path uses. */
export function createMediaSender(port: MediaPort, allowed: (target: Target) => boolean): MediaSender {
  return async request => {
    if (!allowed(request.target)) throw Object.assign(new Error('Delivery target outside instance authority'), { definitelyNotSent: true });
    return uploadTelegramMedia(port, request.target, request.file, request.replyToMessageId);
  };
}

const safeName = (path: string) => basename(path).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 120) || 'file';
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);

export type NativeMediaOutboundOptions = {
  runtime: () => IngressRuntime;
  /** Private immutable store for outbound copies. Use a separate root from inbound artifacts and a 50 MB file limit. */
  store: MediaArtifactStore;
  /** The file tool's read authority. Returns the canonical regular-file path or throws. Required: there is no default. */
  authorize: (path: string, conversationId: ConversationId) => Promise<string>;
};

export function createNativeMediaOutbound(options: NativeMediaOutboundOptions) {
  /** The earliest human source of this conversation whose run has not settled: follow-up inputs run in order.
   * The admission receipt may not be recorded yet when the tool runs, so a missing submission counts as unsettled. */
  async function currentSource(conversationId: ConversationId) {
    const p = options.runtime();
    const state = await p.harness.snapshot(Bindings, p.root.id, context);
    const live = Object.entries(state?.sources ?? {}).filter(([, binding]) => binding.conversationId === conversationId && !binding.cancelled && !binding.deliveryComplete)
      .sort((a, b) => a[1].originalAt - b[1].originalAt);
    for (const candidate of live) {
      const submission = await p.root.commit(tx => tx.submissionByRequest(conversationId, candidate[0]), context);
      if (submission && submission.type === 'input' && (submission.status === 'done' || submission.status === 'unanswered')) continue;
      return candidate;
    }
    return undefined;
  }

  const tool = defineTool({
    name: 'telegram_attach',
    description: 'Queue up to 10 local files to be sent with the reply to the active Telegram message. Files are copied when queued and sent after the reply text.',
    parameters: Type.Object({ paths: Type.Array(Type.String({ description: 'Local file path to attach' }), { minItems: 1, maxItems: MAX_OUTBOUND_FILES_PER_TURN }) }),
    replay: 'unsafe',
    execute: async (args, api) => {
      const found = await currentSource(api.conversationId);
      if (!found) return textToolResult('telegram_attach can only queue files while replying to an active Telegram message.', true);
      const [key] = found;
      const p = options.runtime();
      const queued = (await p.harness.snapshot(MediaOutbox, p.root.id, context))?.items[key]?.files.length ?? 0;
      if (queued + args.paths.length > MAX_OUTBOUND_FILES_PER_TURN) return textToolResult(`Attachment limit reached (${MAX_OUTBOUND_FILES_PER_TURN}). Nothing was queued.`, true);
      const storeKey = `out:${key}:${api.callId}`;
      const files: OutboundFile[] = [];
      try {
        for (const [index, path] of args.paths.entries()) {
          const canonical = await options.authorize(path, api.conversationId);
          const name = safeName(canonical);
          const ref = await options.store.stage(storeKey, index, { kind: 'outbound', name, image: false }, { path: canonical });
          files.push({ id: `${api.callId}:${index}`, storeKey, ref, name, status: 'queued', attempts: 0, notice: 'none' });
        }
      } catch (error) {
        await options.store.retire(storeKey);
        // All or nothing: no file of a failed call is queued.
        return textToolResult(`Nothing was queued: ${error instanceof MediaArtifactError ? error.message : reason(error)}`, true);
      }
      await p.root.commit(async tx => {
        const doc = await tx.doc(MediaOutbox, p.root.id);
        if (doc.items[key] === undefined) doc.items[key] = { files: [] };
        const group = doc.items[key]!;
        for (const file of files) if (!group.files.some(existing => existing.id === file.id)) group.files.push(file);
      }, context);
      return textToolResult(`Queued ${files.length} Telegram attachment(s).`);
    },
  });
  const bundle: NativeBundle = { name: 'telegram-media', tools: [{ version: 1, tool }], close: async () => undefined };

  /** One serialized host line. Call after `reconcileDeliveries`. Sends each queued file at most once. */
  async function reconcile(send: MediaSender, notify: MediaNotifier): Promise<void> {
    const p = options.runtime();
    const bindings = (await p.harness.snapshot(Bindings, p.root.id, context))?.sources ?? {};
    const set = (key: string, id: string, patch: (file: OutboundFile) => void) => p.root.commit(async tx => {
      const file = (await tx.doc(MediaOutbox, p.root.id)).items[key]?.files.find(item => item.id === id);
      if (!file) throw new Error('Outbound media record missing');
      patch(file);
    }, context);
    for (const [key, binding] of Object.entries(bindings)) {
      // Text first: the final reply ledger completes before any file goes out.
      if (!binding.deliveryComplete) continue;
      const group = (await p.harness.snapshot(MediaOutbox, p.root.id, context))?.items[key];
      if (!group) continue;
      const target: Target = { chatId: binding.chatId, ...(binding.threadId === null ? {} : { threadId: binding.threadId }) };
      const replyTo = binding.envelope.messageIds.at(-1);
      for (const initial of group.files) {
        let file = (await p.harness.snapshot(MediaOutbox, p.root.id, context))!.items[key]!.files.find(item => item.id === initial.id)!;
        if (binding.cancelled && file.status === 'queued') { await set(key, file.id, value => { value.status = 'failed'; value.error = 'The request was cancelled.'; value.notice = 'done'; }); continue; }
        if (file.status === 'sending') { await set(key, file.id, value => { value.status = 'uncertain'; }); file = { ...file, status: 'uncertain' }; }
        if (file.status === 'queued') {
          await set(key, file.id, value => { value.status = 'sending'; value.attempts += 1; });
          let outcome: { status: OutboundFileState; messageId?: number; error?: string };
          try {
            const { bytes } = await options.store.open(file.ref);
            const receipt = await send({ target, ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }), file: { bytes, name: file.name }, identity: `${key}:${file.id}` });
            if (!receipt || !Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0) throw new Error('Missing delivery acknowledgement');
            outcome = { status: 'delivered', messageId: receipt.messageId };
          } catch (error) {
            const definite = error instanceof MediaArtifactError || (typeof error === 'object' && error !== null && 'definitelyNotSent' in error && (error as { definitelyNotSent?: unknown }).definitelyNotSent === true);
            outcome = { status: definite ? (file.attempts + 1 >= MAX_SEND_ATTEMPTS || error instanceof MediaArtifactError ? 'failed' : 'queued') : 'uncertain', error: reason(error) };
          }
          await set(key, file.id, value => { value.status = outcome.status; if (outcome.messageId !== undefined) value.messageId = outcome.messageId; if (outcome.error !== undefined) value.error = outcome.error; });
          if (outcome.status === 'queued') break; // Retry on a later pass, keeping file order.
          file = { ...file, status: outcome.status, ...(outcome.error === undefined ? {} : { error: outcome.error }) };
        }
        if ((file.status === 'failed' || file.status === 'uncertain') && file.notice === 'none') {
          await set(key, file.id, value => { value.notice = 'sending'; });
          const text = file.status === 'failed' ? `Failed to send attachment ${file.name}: ${file.error ?? 'unknown error'}` : `Telegram attachment ${file.name} may not have been delivered. It was not sent again.`;
          let notice: OutboundFile['notice'] = 'done';
          try { await notify(target, text, replyTo); } catch { notice = 'unknown'; }
          await set(key, file.id, value => { value.notice = notice; });
        } else if (file.notice === 'sending') await set(key, file.id, value => { value.notice = 'unknown'; });
      }
    }
  }

  /** Source keys of outbound artifacts that still await delivery. Pass to `store.sweep` so unfinished files are kept. */
  async function liveStoreKeys(): Promise<string[]> {
    const p = options.runtime();
    const items = (await p.harness.snapshot(MediaOutbox, p.root.id, context))?.items ?? {};
    return Object.values(items).flatMap(group => group.files.filter(file => file.status === 'queued' || file.status === 'sending').map(file => file.storeKey));
  }
  return { bundle, reconcile, liveStoreKeys };
}
export type NativeMediaOutbound = ReturnType<typeof createNativeMediaOutbound>;
