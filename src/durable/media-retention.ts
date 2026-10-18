/** Artifact bytes are temporary; source identity and effect receipts remain durable.
 * Commit retirement before removing bytes. Never retire unfinished work or a conversation with a live task.
 */
import { defineDoc, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { Bindings, context, sourceKey, type IngressRuntime, type SourceEnvelope } from './ingress.js';
import { assertMediaAttachments } from './media-ingest.js';
import { MediaOutbox } from './media-outbound.js';
import type { MediaArtifactStore } from './media-artifacts.js';

export const MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type Retirement = { settledAt: number; retiredAt: number | null };
export const MediaRetirement = defineDoc({ kind: 'bridge.media-retirement', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ sources: {} as Record<string, Retirement>, outbound: {} as Record<string, Retirement> }) });

export function createMediaRetention(options: { runtime: () => IngressRuntime; inbound: MediaArtifactStore; outbound: MediaArtifactStore; inboundPending?: () => Promise<boolean>; now?: () => number }) {
  const now = options.now ?? Date.now;
  let lastPass = -Infinity;
  async function reconcile(force = false) {
    if (!force && now() - lastPass < 60_000) return;
    const p = options.runtime(), at = now(), pendingAlbum = await options.inboundPending?.() ?? false;
    const state = await p.harness.snapshot(Bindings, p.root.id, context);
    const outbox = await p.harness.snapshot(MediaOutbox, p.root.id, context);
    const inspection = await p.harness.inspect(context);
    const busy = new Set(inspection.tasks.filter(task => task.record.state.status !== 'terminal').map(task => task.record.conversationId));
    for (const cid of Object.values(state?.epochs ?? {})) {
      const live = await p.harness.snapshot(LiveDoc, cid, context), inbox = await p.harness.snapshot(InboxDoc, cid, context);
      if (live?.run || live?.compactions?.length || inbox?.items.length) busy.add(cid);
    }
    const pending = new Set(p.store.inbox.pending().map(row => row.id));
    for (const key of pending) { const binding = state?.sources[key]; if (binding) busy.add(binding.conversationId); }
    const keepIn: string[] = [], keepOut: string[] = [], retireIn: string[] = [], retireOut: string[] = [];
    await p.root.commit(async tx => {
      const doc = await tx.doc(MediaRetirement, p.root.id);
      for (const [key, binding] of Object.entries(state?.sources ?? {})) {
        if (!(binding.envelope.attachments?.length)) continue;
        const sourcePending = !(binding.deliveryComplete || binding.cancelled) || pending.has(key);
        const unfinished = sourcePending || busy.has(binding.conversationId);
        let record = doc.sources[key];
        if (record && record.retiredAt !== null) {
          if (sourcePending) throw new Error('Retired media is referenced by unfinished work');
          retireIn.push(key); continue;
        }
        if (unfinished || pendingAlbum) {
          if (unfinished) delete doc.sources[key]; keepIn.push(key); continue;
        }
        record ??= doc.sources[key] = { settledAt: at, retiredAt: null };
        if (record.retiredAt === null && at - record.settledAt >= MEDIA_RETENTION_MS) record.retiredAt = at;
        if (record.retiredAt === null) keepIn.push(key); else retireIn.push(key);
      }
      const groups = new Map<string, { safe: boolean }>();
      for (const [key, group] of Object.entries(outbox?.items ?? {})) {
        const binding = state?.sources[key];
        for (const file of group.files) {
          const safe = !!binding && !busy.has(binding.conversationId) && (file.status === 'delivered' || file.status === 'failed' || file.status === 'uncertain');
          const prior = groups.get(file.storeKey);
          groups.set(file.storeKey, { safe: safe && (prior?.safe ?? true) });
        }
      }
      for (const [key, { safe }] of groups) {
        let record = doc.outbound[key];
        if (record && record.retiredAt !== null) { retireOut.push(key); continue; }
        if (!safe) { delete doc.outbound[key]; keepOut.push(key); continue; }
        record ??= doc.outbound[key] = { settledAt: at, retiredAt: null };
        if (record.retiredAt === null && at - record.settledAt >= MEDIA_RETENTION_MS) record.retiredAt = at;
        if (record.retiredAt === null) keepOut.push(key); else retireOut.push(key);
      }
    }, context);
    for (const key of retireIn) await options.inbound.retire(key);
    for (const key of retireOut) await options.outbound.retire(key);
    // Unbound failed downloads/copies also expire. A fresh admission cannot race the host's serialized line.
    if (!pendingAlbum) await options.inbound.sweep(keepIn, MEDIA_RETENTION_MS);
    await options.outbound.sweep(keepOut, MEDIA_RETENTION_MS);
    lastPass = at;
  }
  async function validate(envelope: SourceEnvelope) {
    const p = options.runtime();
    const retired = (await p.harness.snapshot(MediaRetirement, p.root.id, context))?.sources[sourceKey(envelope)]?.retiredAt;
    if (retired !== null && retired !== undefined) {
      // Validate immutable reference structure and source authority even after the bytes expire.
      await assertMediaAttachments(envelope, { verifiedPath: async ref => ({ ref: ref as never, path: '' }) });
    } else await assertMediaAttachments(envelope, options.inbound);
  }
  return { reconcile, validate };
}
