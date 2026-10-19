import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createHash } from 'node:crypto';
import { AssistantEntry, defineDoc, watchEvents } from '@earendil-works/pi-durable';

export const TelegramSources = defineDoc({ kind: 'prototype.telegram-sources', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ fingerprints: {} }) });

// Host-facing glue. Durable input idempotency is native; delivery receipts are not implemented.
export function nativeTelegramRuntime(harness, conversation) {
  return {
    async run(input, preview) {
      // The production host must validate its full source envelope before admission.
      // This focused guard binds the adapter's normalized input across reopen.
      const requestId = `telegram:${input.target.chatId}:${input.target.threadId ?? 0}:${input.messageId}`;
      const fingerprint = createHash('sha256').update(JSON.stringify({
        target: { chatId: input.target.chatId, threadId: input.target.threadId ?? null },
        actorId: input.actorId, messageId: input.messageId, text: input.text, attachments: input.attachments ?? [],
      })).digest('hex');
      await conversation.commit(async tx => {
        const state = await tx.doc(TelegramSources, conversation.id);
        if (Object.hasOwn(state.fingerprints, requestId) && state.fingerprints[requestId] !== fingerprint) throw new Error('Telegram source payload conflict');
        state.fingerprints[requestId] = fingerprint;
      }, context);
      const events = await watchEvents(harness, conversation.id, context);
      let text = '';
      const pending = [];
      events.start(async (batch) => {
        for (const event of batch) {
          if (event.type === 'message_start' && event.message.role === 'assistant') {
            text = event.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
            if (text && event.message.stopReason === 'pending') { const frame = preview(text); pending.push(frame); await frame; }
          }
          if (event.type === 'message_update') {
            for (const change of event.changes) {
              if (change.type === 'text_delta') text += change.delta;
              if (change.type === 'message') text = change.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
            }
            if (text) { const frame = preview(text); pending.push(frame); await frame; }
          }
        }
      });
      try {
        const submission = await conversation.submit({ type: 'input', content: input.text,
          entry: { kind: 'prototype.telegram-input', data: { target: input.target, actorId: input.actorId, messageId: input.messageId, attachments: input.attachments ?? [] } },
          requestId }, context);
        const settled = await submission.wait(context);
        if (settled.status !== 'done' || settled.type !== 'input') throw new Error('Telegram input unanswered');
        const answer = await conversation.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
        await events.stop();
        await Promise.all(pending);
        return answer.model.filter(message => message.role === 'assistant').flatMap(message => message.content).filter(b => b.type === 'text').map(b => b.text).join('');
      } finally { await events.stop(); }
    },
  };
}
