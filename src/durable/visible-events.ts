import { LiveDoc, watchEvents, type AgentEvent, type AgentEventStream, type ConversationId, type MessageChange, type SubmissionId } from '@earendil-works/pi-durable';
import type { NativeConfig } from './config.js';
import type { DurableHost } from './host.js';
import { Bindings, context, type Target } from './ingress.js';

type Block = { type?: string; text?: unknown };
export interface VisibleEventsOptions {
  host: () => DurableHost;
  config: NativeConfig;
  stream: { update(target: Target, turn: string, text: string): void; finish(target: Target, turn: string): Promise<void> };
  /** Receives fixed lifecycle labels only; the caller gates it to the originating target. */
  debug: (title: string, value: unknown) => void;
}

const toolLabel = (name: unknown) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : 'tool';
/** Only assistant text blocks count; thinking, tool calls and everything else stay hidden. */
const textOf = (blocks: unknown): Map<number, string> => {
  const out = new Map<number, string>();
  if (Array.isArray(blocks)) blocks.forEach((b: Block, i) => { if (b?.type === 'text' && typeof b.text === 'string') out.set(i, b.text); });
  return out;
};

/** Best-effort observer: errors never reach the caller and never affect durable state. */
export function createVisibleEvents(options: VisibleEventsOptions) {
  const target: Target = { chatId: options.config.transport.allowedUserId };
  let chain: Promise<unknown> = Promise.resolve();
  let observer: { id: number; cid: ConversationId; watch: AgentEventStream; turns: Set<string>; settle: () => Promise<void> } | undefined;
  let nextObserver = 0, closed = false;
  let lastConversation: ConversationId | undefined;
  const safeDebug = (title: string, value: unknown) => { try { options.debug(title, value); } catch { /* diagnostics are optional */ } };
  const queue = <T>(work: () => Promise<T>): Promise<T> => { const run = chain.then(work, work); chain = run.catch(() => undefined); return run; };

  async function isCurrent(cid: ConversationId): Promise<boolean> {
    const host = options.host();
    const state = await host.runtime.harness.snapshot(Bindings, host.runtime.root.id, context);
    return !!state && state.epochs[String(state.epoch)] === cid;
  }

  async function stop(current: NonNullable<typeof observer>) {
    if (observer === current) observer = undefined;
    await current.watch.stop().catch(() => undefined);
  }

  async function previewInputs(inputs: readonly SubmissionId[] = []): Promise<boolean> {
    if (options.config.jobsRole !== 'recipient') return true;
    if (!inputs.length) return false;
    try {
      const host = options.host();
      const state = await host.runtime.harness.snapshot(Bindings, host.runtime.root.id, context);
      for (const id of inputs) {
        const record = await (await host.runtime.harness.submission(id, context))?.status(context);
        const binding = record?.requestId ? state?.sources[record.requestId] : undefined;
        if (!binding || binding.proactive) return false;
      }
      return true;
    } catch { return false; } // Unknown source authority never permits a preview.
  }

  async function start(cid: ConversationId, watch: AgentEventStream) {
    const me = { id: ++nextObserver, cid, watch, turns: new Set<string>(), settle: async () => {} };
    observer = me; lastConversation = cid;
    let preview = await previewInputs(watch.snapshot.run?.inputs);
    const refreshPreview = async () => {
      if (options.config.jobsRole !== 'recipient' || !preview) return;
      // A run can gain inputs at a tool boundary without another run_start.
      // The attach snapshot is fixed. Read public live state before publishing
      // the next turn and keep suppression sticky until the next run.
      preview = false;
      const live = await options.host().runtime.harness.snapshot(LiveDoc, cid, context);
      preview = await previewInputs(live?.run?.inputs);
    };
    let seq = 0, turn = '', finished = false, texts = new Map<number, string>(), last = '';
    const newTurn = () => { turn = `${me.id}:${++seq}`; finished = false; texts = new Map(); last = ''; };
    const publish = () => {
      if (observer !== me || finished || !preview) return;
      const text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]).join('');
      if (!text.trim() || text === last) return;
      last = text; me.turns.add(turn);
      try { options.stream.update(target, turn, text); } catch { /* preview only */ }
    };
    const ensureTurn = () => { if (!turn) newTurn(); };
    const change = (c: MessageChange) => {
      if (c.type === 'text_start') texts.set(c.contentIndex, (c.block as Block).type === 'text' ? String((c.block as Block).text ?? '') : '');
      else if (c.type === 'text_delta') texts.set(c.contentIndex, (texts.get(c.contentIndex) ?? '') + c.delta);
      else if (c.type === 'block') { if ((c.block as Block).type === 'text') texts.set(c.contentIndex, String((c.block as Block).text ?? '')); else texts.delete(c.contentIndex); }
      else if (c.type === 'message') texts = textOf(c.message.content);
    };
    const handle = async (event: AgentEvent) => {
      if (observer !== me) return;
      switch (event.type) {
        case 'snapshot':
          // Watch overflow replaces queued events with a new atomic snapshot.
          preview = false; preview = await previewInputs(event.run?.inputs);
          await refreshPreview(); newTurn(); texts = textOf(event.generation?.message?.content); publish(); break;
        case 'run_start': preview = false; preview = await previewInputs(event.inputs); safeDebug('durable run', { event: 'run_start', inputs: event.inputs.length }); break;
        case 'run_end': preview = options.config.jobsRole !== 'recipient'; safeDebug('durable run', { event: 'run_end', inputs: event.inputs.length }); break;
        case 'turn_start': await refreshPreview(); newTurn(); safeDebug('durable turn', { event: 'turn_start' }); break;
        case 'turn_end': safeDebug('durable turn', { event: 'turn_end' }); break;
        case 'message_start': {
          const m = event.message as { role?: string; content?: unknown };
          if (m.role === 'assistant') { await refreshPreview(); if (!turn || finished) newTurn(); texts = textOf(m.content); last = ''; publish(); }
          break;
        }
        case 'message_update': ensureTurn(); for (const c of event.changes) change(c); publish(); break;
        case 'tool_execution_start': safeDebug('durable tool', { event: 'start', tool: toolLabel(event.toolName) }); break;
        case 'tool_execution_end': safeDebug('durable tool', { event: 'end', tool: toolLabel(event.toolName) }); break;
        case 'auto_retry_start': safeDebug('durable retry', { event: 'retry', attempt: event.attempt }); break;
        case 'compaction_start': safeDebug('durable compaction', { event: 'start' }); break;
        case 'compaction_end': safeDebug('durable compaction', { event: 'end', failed: event.error !== undefined }); break;
        case 'task_failed': safeDebug('durable task', { event: 'failed' }); break;
        default: break;
      }
    };
    // The snapshot may already hold a partial assistant message for a running turn.
    const partial = watch.snapshot.generation?.message;
    if (partial) { newTurn(); texts = textOf(partial.content); publish(); }
    me.settle = async () => {
      finished = true; // Late events of this turn are dropped until the next turn or message starts.
      const turns = [...me.turns]; me.turns.clear();
      for (const t of turns) await options.stream.finish(target, t).catch(() => undefined);
    };
    watch.start(async events => { if (observer !== me) return; for (const e of events) { try { await handle(e); } catch { /* ignore malformed event */ } } });
    const ended = () => {
      if (observer !== me) return;
      void queue(async () => {
        if (observer !== me) return;
        observer = undefined;
        await me.settle();
      }).catch(() => undefined);
    };
    void watch.closed.then(ended, ended);
  }

  return {
    attach(cid: ConversationId): Promise<void> {
      return queue(async () => {
        if (closed) return;
        try {
          if (observer?.cid === cid) return;
          if (!await isCurrent(cid)) return;
          const previous = observer;
          if (previous) await stop(previous);
          const host = options.host();
          const watch = await watchEvents(host.runtime.harness, cid, context);
          if (closed) { await watch.stop().catch(() => undefined); return; }
          await start(cid, watch);
        } catch (error) { safeDebug('durable observer', { event: 'attach_failed', error: error instanceof Error ? error.name : 'error' }); }
      });
    },
    /** A committed final fences all old publications, including unseen queued turns. */
    finish(): Promise<void> {
      return queue(async () => {
        const current = observer, cid = current?.cid ?? lastConversation;
        if (!cid || closed) return;
        if (current) { await stop(current); await current.settle(); }
        // The answer is already committed. A fresh atomic snapshot/watch cannot
        // replay its delayed turn_start/message_start frames after final delivery.
        // If queued work already started, its current partial remains previewable.
        try {
          if (closed || !await isCurrent(cid)) return;
          const watch = await watchEvents(options.host().runtime.harness, cid, context);
          if (closed) { await watch.stop().catch(() => undefined); return; }
          await start(cid, watch);
        } catch (error) { safeDebug('durable observer', { event: 'attach_failed', error: error instanceof Error ? error.name : 'error' }); }
      });
    },
    close(): Promise<void> {
      closed = true;
      return queue(async () => { if (observer) await stop(observer); });
    },
  };
}
