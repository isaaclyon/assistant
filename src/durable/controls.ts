import { createHash } from 'node:crypto';
import { configure, defineDoc, InboxDoc, LiveDoc, type ConversationId } from '@earendil-works/pi-durable';
import { getSupportedThinkingLevels, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { NativeConfig } from './config.js';
import { HostControlRejectedError, type DurableHost } from './host.js';
import { Bindings, context } from './ingress.js';
import type { createNativeProvider } from './provider.js';

type Choice = { provider: string; modelId: string; thinkingLevel: ModelThinkingLevel };
type Receipt = { fingerprint: string; action: string; status: 'executing' | 'done' | 'interrupted' };
export const NativePreferences = defineDoc({
  kind: 'bridge.preferences', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ choice: null as Choice | null, commands: {} as Record<string, Receipt>, restartNotice: null as null | { requestId: string; status: 'pending' | 'sending' | 'done' | 'uncertain' } }),
});

type Models = Awaited<ReturnType<typeof createNativeProvider>>['models'];
/** Trusted commands receive request IDs from authenticated ingress. Mutating
 * commands share the host acceptance line, and retain receipts across restart. */
export function createNativeControls(options: {
  config: NativeConfig; host(): DurableHost; models: Models;
  reload(): Promise<void>; invalidate(): Promise<void>;
  requestRestart(): void;
}) {
  const initial = () => options.host().runtime.agent;
  const restartIssued = new Set<string>();
  const key = (provider: string, modelId: string) => createHash('sha256').update(JSON.stringify([provider, modelId])).digest('hex').slice(0, 32);
  const catalog = () => options.models.getModels().map(model => ({ id: key(model.provider, model.id), label: model.name, model }));
  async function active(): Promise<ConversationId | undefined> {
    const host = options.host();
    const state = await host.runtime.harness.snapshot(Bindings, host.runtime.root.id, context);
    return state?.epochs[String(state.epoch)];
  }
  async function idle(): Promise<boolean> {
    const host = options.host();
    if (host.runtime.store.inbox.pending().length) return false;
    const inspection = await host.runtime.harness.inspect(context);
    return inspection.tasks.length === 0 && inspection.submissions.length === 0;
  }
  async function selected(): Promise<Choice> {
    const host = options.host();
    const saved = await host.runtime.harness.snapshot(NativePreferences, host.runtime.root.id, context);
    const agent = initial();
    if (saved?.choice) return { ...saved.choice };
    if (!agent.model) throw new Error('Native model is unavailable');
    return { ...agent.model, thinkingLevel: agent.thinkingLevel ?? 'off' } as Choice;
  }
  async function once(requestId: string, action: string, payload: unknown, execute: () => Promise<void>) {
    const host = options.host();
    if (![ `telegram-control:${options.config.transport.botId}:`, `telegram-callback:${options.config.transport.botId}:`, `telegram-command:${options.config.transport.botId}:` ].some(prefix => requestId.startsWith(prefix))) throw new Error('Unauthenticated command identity');
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex');
    return host.administration(async () => {
      const prior = (await host.runtime.harness.snapshot(NativePreferences, host.runtime.root.id, context))?.commands[requestId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('Command identity conflict');
        if (prior.status !== 'done') throw new HostControlRejectedError('This command was interrupted. Send a fresh command after inspecting its status.');
        return;
      }
      // Reject before recording only when nothing can have changed. A retried
      // busy command still needs a fresh identity, so persist its rejection.
      const ready = await idle();
      await host.runtime.root.commit(async tx => {
        (await tx.doc(NativePreferences, host.runtime.root.id)).commands[requestId] = { fingerprint, action, status: ready ? 'executing' : 'interrupted' };
      }, context);
      if (!ready) throw new HostControlRejectedError('Wait for pending work to finish or use /stop before changing this setting.');
      try {
        await execute();
        await host.runtime.root.commit(async tx => { (await tx.doc(NativePreferences, host.runtime.root.id)).commands[requestId]!.status = 'done'; }, context);
      } catch (error) {
        await host.runtime.root.commit(async tx => { (await tx.doc(NativePreferences, host.runtime.root.id)).commands[requestId]!.status = 'interrupted'; }, context);
        throw error;
      }
    });
  }
  async function save(choice: Choice) {
    const host = options.host();
    await host.runtime.root.commit(async tx => {
      const binding = await tx.doc(Bindings, host.runtime.root.id);
      const changes = { model: { provider: choice.provider, modelId: choice.modelId }, thinkingLevel: choice.thinkingLevel };
      (await tx.doc(NativePreferences, host.runtime.root.id)).choice = choice;
      await configure(tx, host.runtime.root.id, changes);
      const current = binding.epochs[String(binding.epoch)];
      if (current !== undefined) await configure(tx, current, changes);
    }, context);
    Object.assign(host.runtime.agent, { model: { provider: choice.provider, modelId: choice.modelId }, thinkingLevel: choice.thinkingLevel });
  }
  return {
    async restore() {
      const host = options.host();
      const saved = await host.runtime.harness.snapshot(NativePreferences, host.runtime.root.id, context);
      // A notice present at open belongs to the previous process. Replayed
      // ingress can arrive before its completion notice is sent.
      if (saved?.restartNotice) restartIssued.add(saved.restartNotice.requestId);
      const choice = await selected();
      const model = options.models.getModel(choice.provider, choice.modelId);
      if (!model || !getSupportedThinkingLevels(model).includes(choice.thinkingLevel)) throw new Error('Stored model selection is unavailable');
      // Restore the template used for future epochs before acceptance begins.
      Object.assign(initial(), { model: { provider: choice.provider, modelId: choice.modelId }, thinkingLevel: choice.thinkingLevel });
    },
    async status() { const choice = await selected(); return { model: key(choice.provider, choice.modelId), modelLabel: `${choice.provider}/${choice.modelId}`, thinking: choice.thinkingLevel, busy: !await idle() }; },
    models: () => catalog().map(({ id, label }) => ({ id, label })),
    async thinkingLevels() { const choice = await selected(); const model = options.models.getModel(choice.provider, choice.modelId); return model ? [...getSupportedThinkingLevels(model)] : []; },
    setModel(requestId: string, id: string) {
      const candidate = catalog().find(model => model.id === id)?.model;
      if (!candidate) throw new HostControlRejectedError('That model is unavailable. Open the model menu again.');
      return once(requestId, 'model', id, async () => {
        const previous = await selected(), allowed = getSupportedThinkingLevels(candidate);
        await save({ provider: candidate.provider, modelId: candidate.id, thinkingLevel: allowed.includes(previous.thinkingLevel) ? previous.thinkingLevel : allowed[0] ?? 'off' });
      });
    },
    async setThinking(requestId: string, level: string) {
      return once(requestId, 'thinking', level, async () => {
        const choice = await selected(), model = options.models.getModel(choice.provider, choice.modelId);
        if (!model || !getSupportedThinkingLevels(model).includes(level as ModelThinkingLevel)) throw new HostControlRejectedError('That thinking level is unavailable for this model.');
        await save({ ...choice, thinkingLevel: level as ModelThinkingLevel });
      });
    },
    reload(requestId: string) { return once(requestId, 'reload', null, async () => { await options.invalidate(); await options.reload(); }); },
    async restart(requestId: string) {
      let fresh = false;
      await once(requestId, 'restart', null, async () => {
        const host = options.host();
        await host.runtime.root.commit(async tx => { (await tx.doc(NativePreferences, host.runtime.root.id)).restartNotice = { requestId, status: 'pending' }; }, context);
        fresh = true;
      });
      // If offset persistence failed, a replay in the same process must still
      // request shutdown after its eventual acknowledgement. A reopened process
      // marks its preexisting request as issued before accepting commands.
      const notice = (await options.host().runtime.harness.snapshot(NativePreferences, options.host().runtime.root.id, context))?.restartNotice;
      if (restartIssued.has(requestId) || (!fresh && (notice?.requestId !== requestId || notice.status !== 'pending'))) return undefined;
      return () => { if (!restartIssued.has(requestId)) { restartIssued.add(requestId); options.requestRestart(); } };
    },
    async notifyRestart(send: () => Promise<void>, expectedRequestId?: string) {
      const host = options.host();
      const notice = (await host.runtime.harness.snapshot(NativePreferences, host.runtime.root.id, context))?.restartNotice;
      if (!notice || (expectedRequestId !== undefined && notice.requestId !== expectedRequestId) || notice.status === 'done' || notice.status === 'uncertain') return;
      if (notice.status === 'sending') {
        await host.runtime.root.commit(async tx => { (await tx.doc(NativePreferences, host.runtime.root.id)).restartNotice!.status = 'uncertain'; }, context);
        return;
      }
      await host.runtime.root.commit(async tx => { (await tx.doc(NativePreferences, host.runtime.root.id)).restartNotice!.status = 'sending'; }, context);
      let status: 'done' | 'uncertain' = 'uncertain';
      try { await send(); status = 'done'; } catch { /* A missing acknowledgement never permits a blind resend. */ }
      await host.runtime.root.commit(async tx => { (await tx.doc(NativePreferences, host.runtime.root.id)).restartNotice!.status = status; }, context);
    },
    active,
  };
}
