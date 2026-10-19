/** Coalescing visible-text preview. Callers pass only assistant text meant for the
 * user (never thinking, tool arguments or injected context). Previews are best effort:
 * the durable final ledger (C2) stays authoritative and clears the draft. */
import type { Target } from './ingress.js';
export type PreviewSink = (target: Target, text: string) => Promise<unknown>;
type Slot = { turn: string; latest: string; sent: string; last: number; timer?: ReturnType<typeof setTimeout> | undefined; inflight?: Promise<void> | undefined };
export function createPreviewStream(options: { send: PreviewSink; authorize: (target: Target) => boolean; intervalMs?: number; maxChars?: number; onError?: (error: unknown) => void }) {
  const interval = options.intervalMs ?? 1000, max = options.maxChars ?? 3800;
  const slots = new Map<string, Slot>(), closed = new Map<string, Set<string>>();
  const key = (t: Target) => `${t.chatId}:${t.threadId ?? ''}`;
  const visible = (text: string) => text.length > max ? `…${text.slice(-(max - 1))}` : text;
  function flush(id: string, target: Target, slot: Slot) {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = undefined; }
    if (slot.inflight) return;
    const text = visible(slot.latest);
    if (!text.trim() || text === slot.sent) return;
    slot.sent = text; slot.last = Date.now();
    slot.inflight = options.send({ ...target }, text).then(() => undefined, error => { options.onError?.(error); slot.sent = ''; })
      .finally(() => { slot.inflight = undefined; if (slots.get(id) === slot && visible(slot.latest) !== slot.sent) schedule(id, target, slot); });
  }
  function schedule(id: string, target: Target, slot: Slot) {
    if (slot.timer || slot.inflight) return;
    const wait = Math.max(0, slot.last + interval - Date.now());
    if (wait === 0) flush(id, target, slot);
    else { slot.timer = setTimeout(() => flush(id, target, slot), wait); slot.timer.unref?.(); }
  }
  return {
    update(target: Target, turn: string, text: string): void {
      if (!options.authorize(target) || closed.get(key(target))?.has(turn)) return;
      const id = key(target);
      let slot = slots.get(id);
      if (slot && slot.turn !== turn) { if (slot.timer) clearTimeout(slot.timer); slot = undefined; }
      if (!slot) { slot = { turn, latest: '', sent: '', last: 0 }; slots.set(id, slot); }
      slot.latest = text; schedule(id, { ...target }, slot);
    },
    /** Cancels pending previews and waits for an in-flight one; later updates for this turn are dropped. */
    async finish(target: Target, turn: string): Promise<void> {
      const id = key(target), slot = slots.get(id);
      const set = closed.get(id) ?? new Set<string>(); set.add(turn);
      if (set.size > 16) set.delete(set.values().next().value as string);
      closed.set(id, set);
      if (slot?.turn === turn) {
        // Detach before awaiting: the send's completion must not schedule one
        // more preview, and a newer turn created during the wait must survive.
        slots.delete(id);
        if (slot.timer) clearTimeout(slot.timer);
        await slot.inflight;
      }
    },
    stop(): void { for (const slot of slots.values()) if (slot.timer) clearTimeout(slot.timer); slots.clear(); closed.clear(); },
  };
}
export type PreviewStream = ReturnType<typeof createPreviewStream>;
