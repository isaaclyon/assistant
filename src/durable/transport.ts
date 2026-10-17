/** Native Telegram ownership and acceptance boundary. */
import { createTelegramLockRuntime, resolveTelegramLockKey, isProcessAlive, createTelegramConfigStore,
  normalizeTelegramNativeMarkdown, createTelegramPreviewRuntimeState, flushTelegramPreview } from '@llblab/pi-telegram/durable';
import { dirname } from 'node:path';
import { trustedTelegramFetch } from '../trusted-telegram-ipc.js';
import { assertPresentation, toReplyMarkup, type Presentation } from './telegram-ui.js';

export type TelegramTarget = { chatId: number; threadId?: number };
export type TelegramUpdate = Record<string, unknown> & { update_id: number };
export interface NativeTelegramHooks {
  /** Resolves only once durable inbox/source binding commits. Rejection never acknowledges. */
  accept(update: TelegramUpdate): Promise<void>;
  failed?(error: unknown): void;
  /** Called after the update offset is durably advanced. Errors go to failed(). */
  acknowledged?(updateId: number): void | Promise<void>;
}
export type NativeTelegramOptions = { botId: number; allowedUserId: number } & ({
  mode: 'ordinary'; configPath: string; locksPath: string; cwd: string; profile?: string;
  fetch?: typeof fetch;
} | { mode: 'restricted'; socketPath: string });

export class TelegramDeliveryError extends Error {
  readonly definitelyNotSent: boolean;
  constructor(public readonly outcome: 'failed' | 'uncertain', message: string) { super(message); this.definitelyNotSent = outcome === 'failed'; }
}

export function createNativeTelegramTransport(options: NativeTelegramOptions) {
  const ordinary = options.mode === 'ordinary';
  const config = ordinary ? createTelegramConfigStore({ configPath: options.configPath, agentDir: dirname(options.configPath) }) : undefined;
  const lock = ordinary ? createTelegramLockRuntime({ locksPath: options.locksPath,
    key: resolveTelegramLockKey(options.profile) }) : undefined;
  const context = { cwd: ordinary ? options.cwd : '' };
  const request = ordinary ? options.fetch ?? fetch : trustedTelegramFetch(options.socketPath);
  let token = 'restricted';
  let offset = 0;
  let controller: AbortController | undefined;
  let work: Promise<void> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let hooks: NativeTelegramHooks;
  let stopped = true;
  let initialized = false;
  let ready: ((status: 'ready' | 'waiting-owner') => void) | undefined;
  let startupFailure: ((error: unknown) => void) | undefined;
  let draftId = 0;
  const previews = new Map<string, ReturnType<typeof createTelegramPreviewRuntimeState>>();
  const key = (target: TelegramTarget) => JSON.stringify(target);
  const owns = () => !stopped && (!lock || lock.owns(context));
  async function call(method: string, body: unknown, signal?: AbortSignal): Promise<any> {
    if (!owns()) throw new TelegramDeliveryError('failed', 'Telegram ownership unavailable');
    // A response may finish after pairing is revoked. Recheck ordinary outbound
    // authority at the effect boundary, independently of the polling loop.
    if (config && method !== 'getMe' && method !== 'getUpdates') {
      try {
        await config.load(); validateConfig();
        if (config.getBotToken() !== token) throw new Error('Telegram credentials changed');
      } catch { throw new TelegramDeliveryError('failed', 'Telegram identity unavailable'); }
      if (!owns()) throw new TelegramDeliveryError('failed', 'Telegram ownership unavailable');
    }
    let response: Response;
    try {
      response = await request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
      });
    } catch { throw new TelegramDeliveryError('uncertain', 'Telegram acknowledgement unavailable'); }
    let payload: any;
    try { payload = await response.json(); } catch { throw new TelegramDeliveryError('uncertain', 'Telegram acknowledgement invalid'); }
    if (!response.ok || payload?.ok !== true) throw new TelegramDeliveryError('uncertain', 'Telegram request unavailable');
    return payload.result;
  }
  function validateConfig() {
    if (!config || options.mode !== 'ordinary') return;
    if (!config.activateProfile(options.profile)) throw new Error('Telegram profile unavailable');
    const current = config.get();
    if (current.allowedUserId !== options.allowedUserId || (current.botId !== undefined && current.botId !== options.botId)) throw new Error('Telegram identity mismatch');
  }
  async function persistOffset(id: number) {
    if (config) {
      // Reload before editing so unrelated settings/profile changes survive.
      await config.load();
      validateConfig();
      config.update(value => { value.lastUpdateId = id; });
      await config.persist();
    }
    offset = id + 1;
  }
  async function poll() {
    while (owns() && !controller!.signal.aborted) {
      try {
        const batch = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'edited_message', 'callback_query'] }, controller!.signal);
        if (!Array.isArray(batch)) throw new Error('Invalid Telegram updates');
        for (const update of batch) {
          if (!owns() || controller!.signal.aborted) return;
          if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
          if (config) { await config.load(); validateConfig(); }
          if (!owns() || controller!.signal.aborted) return;
          await hooks.accept(structuredClone(update));
          if (!owns() || controller!.signal.aborted) return;
          await persistOffset(update.update_id);
          try { await hooks.acknowledged?.(update.update_id); } catch (error) { hooks.failed?.(error); }
        }
      } catch (error) {
        if (stopped || controller!.signal.aborted) return;
        hooks.failed?.(error);
        return; // Five-second monitor reconnects; offset remains unacknowledged.
      }
    }
  }
  async function reconcile() {
    if (stopped || work) return;
    work = (async () => {
      if (lock && !lock.owns(context)) {
        const state = lock.getState();
        // A stale heartbeat does not prove that a live process stopped polling.
        if ('lock' in state && isProcessAlive(state.lock.pid)) { ready?.('waiting-owner'); ready = undefined; return; }
        if (!lock.acquire(context).ok) { ready?.('waiting-owner'); ready = undefined; return; }
        initialized = false;
      }
      controller = new AbortController();
      if (!initialized) {
        if (config) {
          await config.load(); validateConfig();
          token = config.getBotToken() ?? '';
          if (!token) throw new Error('Telegram configuration unavailable');
          offset = (config.get().lastUpdateId ?? -1) + 1;
        }
        const me = await call('getMe', {}, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
        if (me?.id !== options.botId) throw new Error('Telegram bot identity mismatch');
        initialized = true;
      }
      ready?.('ready'); ready = undefined; startupFailure = undefined;
      await poll();
    })().catch(error => {
      initialized = false;
      if (lock?.owns(context)) lock.release();
      startupFailure?.(error); ready = undefined; startupFailure = undefined;
      hooks.failed?.(error);
    }).finally(() => { work = undefined; });
    await work;
  }
  return {
    async start(input: NativeTelegramHooks) {
      if (!stopped) throw new Error('Telegram transport already started');
      hooks = input; stopped = false; initialized = false;
      monitor = setInterval(() => { if (!owns()) controller?.abort(); void reconcile(); }, 5_000);
      monitor.unref();
      const startup = new Promise<'ready' | 'waiting-owner'>((resolve, reject) => { ready = resolve; startupFailure = reject; });
      void reconcile();
      try { return await startup; } catch (error) { await this.stop(); throw error; }
    },
    async stop() {
      stopped = true;
      if (monitor) clearInterval(monitor);
      controller?.abort();
      await work;
      if (lock?.owns(context)) lock.release();
      previews.clear();
    },
    async deliver(target: TelegramTarget, text: string, replyToMessageId?: number) {
      target = { ...target };
      const preview = previews.get(key(target));
      if (preview?.flushPromise) await preview.flushPromise;
      previews.delete(key(target));
      const markdown = normalizeTelegramNativeMarkdown(text);
      if (!markdown || markdown.length > 4096) throw new TelegramDeliveryError('failed', 'Telegram ledger segment exceeds message limit');
      const receipt = await call('sendRichMessage', { chat_id: target.chatId,
        ...(target.threadId === undefined ? {} : { message_thread_id: target.threadId }),
        ...(replyToMessageId === undefined ? {} : { reply_parameters: { message_id: replyToMessageId } }),
        rich_message: { markdown, skip_entity_detection: true } });
      if (!Number.isSafeInteger(receipt?.message_id)) throw new TelegramDeliveryError('uncertain', 'Telegram receipt missing');
      return receipt.message_id as number;
    },
    async preview(target: TelegramTarget, text: string) {
      target = { ...target };
      const id = key(target);
      const state = previews.get(id) ?? createTelegramPreviewRuntimeState();
      state.pendingText = text; previews.set(id, state);
      await flushTelegramPreview(target.chatId, {
        getState: () => previews.get(id), setState: next => { if (next) previews.set(id, next); else previews.delete(id); },
        maxMessageLength: 4096, getDraftSupport: () => 'supported', setDraftSupport() {}, allocateDraftId: () => ++draftId,
        sendDraft: (chatId, draft, markdown, params) => call('sendRichMessageDraft', {
          chat_id: chatId, draft_id: draft, rich_message: { markdown, skip_entity_detection: true }, ...params }),
      }, { target });
    },
    /** Plain-text message with optional inline buttons. Every call passes the per-effect ownership and pairing check. */
    async present(target: TelegramTarget, value: Presentation, replyToMessageId?: number) {
      target = { ...target };
      const view = assertPresentation(value), markup = toReplyMarkup(view.buttons);
      const receipt = await call('sendMessage', { chat_id: target.chatId,
        ...(target.threadId === undefined ? {} : { message_thread_id: target.threadId }),
        ...(replyToMessageId === undefined ? {} : { reply_parameters: { message_id: replyToMessageId } }),
        text: view.text, ...(markup ? { reply_markup: markup } : {}) });
      if (!Number.isSafeInteger(receipt?.message_id)) throw new TelegramDeliveryError('uncertain', 'Telegram receipt missing');
      return receipt.message_id as number;
    },
    /** Replaces text and buttons of an earlier presentation. */
    async edit(target: TelegramTarget, messageId: number, value: Presentation) {
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TelegramDeliveryError('failed', 'Invalid message');
      const view = assertPresentation(value), markup = toReplyMarkup(view.buttons);
      await call('editMessageText', { chat_id: target.chatId, message_id: messageId, text: view.text, reply_markup: markup ?? { inline_keyboard: [] } });
    },
    /** Explicit callback/control output port; acceptance remains in the durable hook. */
    answerCallback(callbackId: string, text: string) { return call('answerCallbackQuery', { callback_query_id: callbackId, text }); },
    reconcile,
  };
}
