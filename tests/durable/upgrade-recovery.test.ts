import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTask } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { DurableHost, type HostConfig } from '../../src/durable/host.js';
import { openHostStorage } from '../../src/durable/storage.js';
import { Bindings, accept, context, normalize } from '../../src/durable/ingress.js';

// Synthetic offline proof for the native pending-task upgrade path. Everything runs on a real
// Harness SQLite file with a faux model, a fake transport, and a synthetic task definition.
const dirs: string[] = [];
const hosts: DurableHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
type Version = 'v1' | 'v2' | 'v2-no-migrate' | 'v2-bad-migrate' | 'none';
const compatibility = { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' };
const envelope = { instance: 'test', principal: 'person', bot: 'bot', chatId: 10, threadId: 2, messageIds: [1], originalAt: 1700000000001, content: 'pending input' };
function taskFor(version: Version, seen: Array<{ input: JsonValue; phase: string }>) {
  const migrate = (input: JsonValue, checkpoint: JsonValue, from: number) => {
    if (version === 'v2-bad-migrate') throw new Error('SYNTHETIC_MIGRATION_FAILURE');
    if (from !== 1) throw new Error('Unsupported source version');
    return { input: { ...(input as object), upgraded: true } as never, checkpoint: { phase: 'run', note: (checkpoint as { note: string }).note } as never };
  };
  return defineTask<{ id: string }, { phase: 'run'; note: string }, string, object>({
    name: 'fixture.pending', version: version === 'v1' ? 1 : 2,
    initial: () => ({ phase: 'run', note: 'created-by-v1' }),
    phases: { run: async (running, runtime, ctx) => {
      seen.push({ input: running.input as JsonValue, phase: running.state.checkpoint.phase });
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: 'done' } }), ctx);
    } },
    abort: async (_running, runtime, ctx) => { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } } as never), ctx); },
    ...(version === 'v2' || version === 'v2-bad-migrate' ? { migrate } : {}),
  });
}
async function open(dir: string, version: Version, extra: Partial<HostConfig> = {}) {
  const registry = createRegistry(), seen: Array<{ input: JsonValue; phase: string }> = [];
  const task = taskFor(version === 'none' ? 'v1' : version, seen);
  if (version !== 'none') registry.install(defineExtension({ name: 'fixture', tasks: [task] }));
  const faux = fauxProvider({ tokensPerSecond: 1e9 }); let modelCalls = 0;
  faux.setResponses([() => { modelCalls++; return fauxAssistantMessage('MODEL'); }]);
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
  const calls = { transportStart: 0, sends: 0, reconcileSources: 0 };
  const host = await DurableHost.create({
    stateDir: dir, models, registry, agent: { model: { provider: model.provider, modelId: model.id } }, compatibility,
    transport: { async start() { calls.transportStart++; }, async stop() {}, async sendFinal() { calls.sends++; return { messageId: calls.sends }; } },
    policy() {}, controlPolicy() {}, reconcileSources: async () => { calls.reconcileSources++; },
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, ...extra,
  });
  hosts.push(host);
  return { host, task, seen, calls, modelCalls: () => modelCalls };
}
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'upgrade-recovery-')); dirs.push(dir); return dir; }
/** Create a live v1 task and an accepted-but-unstarted input, then close without running anything. */
async function seedPending(dir: string) {
  const first = await open(dir, 'v1');
  const taskId = await first.host.runtime.root.commit(tx => tx.createTask(first.task, { id: 'synthetic' }, { ownership: { kind: 'conversation' }, conversationId: first.host.runtime.root.id }), context);
  // accept() binds and persists the input; only admit() would submit it and enable scheduling.
  await accept(first.host.runtime, normalize(envelope));
  expect(first.seen).toEqual([]);
  await first.host.close();
  return taskId;
}
async function stateOf(dir: string) {
  const probe = await open(dir, 'v1');
  try {
    const inspection = await probe.host.runtime.harness.inspect(context);
    const bindings = await probe.host.runtime.harness.snapshot(Bindings, probe.host.runtime.root.id, context);
    return { tasks: inspection.tasks.map(t => ({ id: t.record.id, version: t.record.version, state: t.record.state })), submissions: inspection.submissions.map(s => ({ id: s.id, status: s.status })), sources: Object.keys(bindings?.sources ?? {}), inbox: probe.host.runtime.store.inbox.pending().length };
  } finally { await probe.host.close(); }
}

it('upgrades a pending v1 task to the exact v2 definition across reopen', async () => {
  const dir = await directory(), taskId = await seedPending(dir);
  const second = await open(dir, 'v2');
  expect((await second.host.runtime.harness.inspect(context)).tasks.find(t => t.record.id === taskId)?.state).toEqual({ kind: 'ready', migrates: true });
  await second.host.start();
  await second.host.runtime.harness.waitForTask(taskId, context);
  expect(second.seen).toEqual([{ input: { id: 'synthetic', upgraded: true }, phase: 'run' }]);
  expect(second.calls.transportStart).toBe(1);
});

for (const [version, reason] of [['none', 'missing_task'], ['v2-no-migrate', 'migration_failed'], ['v2-bad-migrate', 'migration_failed']] as const) {
  it(`refuses ${version} (${reason}) before transport, model, sources, and submission, keeping pending state`, async () => {
    const dir = await directory(); await seedPending(dir);
    const before = await stateOf(dir);
    expect(before.tasks).toHaveLength(1); expect(before.sources).toHaveLength(1); expect(before.inbox).toBe(1);
    const reopened = await open(dir, version);
    const inspected = (await reopened.host.runtime.harness.inspect(context)).tasks[0]!.state;
    // Harness 1.3.0 reports a throwing migrate() as ready; the host dry-runs it itself.
    expect(inspected).toMatchObject(version === 'v2-bad-migrate' ? { kind: 'ready', migrates: true } : { kind: 'blocked', reason });
    await expect(reopened.host.start()).rejects.toThrow('Recovery blocked');
    expect(reopened.calls).toEqual({ transportStart: 0, sends: 0, reconcileSources: 0 });
    expect(reopened.modelCalls()).toBe(0); expect(reopened.seen).toEqual([]);
    await reopened.host.close().catch(() => {});
    expect(await stateOf(dir)).toEqual(before);
    // The original definition still recovers it, so refusal lost no data.
    const original = await open(dir, 'v1');
    await original.host.start();
    await original.host.runtime.harness.waitForIdle(context);
    expect(original.seen).toHaveLength(1);
  });
}

it('a failed shutdown keeps the OS writer lease until the process ends', async () => {
  const dir = await directory();
  const { host } = await open(dir, 'v1', { closeTimeoutMs: 50, transport: { async start() {}, stop: () => new Promise<void>(() => {}), async sendFinal() { return { messageId: 1 }; } } });
  await expect(host.close()).rejects.toThrow('deadline');
  expect(host.health).toBe('failed');
  await expect(openHostStorage(dir)).rejects.toThrow();
  const probe = new DatabaseSync(join(dir, 'writer.lock.db'));
  try { expect(() => probe.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')).toThrow(); } finally { probe.close(); }
});

it('migrates an exact legacy signature and refreshes existing instructions without replacing model preferences', async()=>{
 const {configure,AgentDoc}=await import('@earendil-works/pi-durable');
 const {HostState}=await import('../../src/durable/host.js');
 const dir=await directory(),first=await open(dir,'v1');
 const cid=await first.host.runtime.root.commit(async tx=>{
  const c=await tx.createConversation({ownership:{kind:'ownerless'}});
  await configure(tx,c.id,{instructions:'old instructions',thinkingLevel:'low'});
  (await tx.doc(Bindings,first.host.runtime.root.id)).epochs['0']=c.id;return c.id;
 },context);
 await first.host.close();
 const nextCompatibility={...compatibility,releaseSchema:2,registrySignature:'contract-only'};
 const next=await open(dir,'v1',{compatibility:nextCompatibility,previousCompatibility:compatibility,instructionRevision:'new-revision',agent:{instructions:'new instructions'}});
 // Inspection/construction alone must not migrate the store.
 expect((await next.host.runtime.harness.snapshot(AgentDoc,cid,context))?.instructions).toBe('old instructions');
 await next.host.validateRecovery();
 expect(await next.host.runtime.harness.snapshot(AgentDoc,cid,context)).toMatchObject({instructions:'new instructions',thinkingLevel:'low'});
 expect((await next.host.runtime.harness.snapshot(HostState,next.host.runtime.root.id,context))?.compatibility).toEqual(nextCompatibility);
 await next.host.close();
 const reopened=await open(dir,'v1',{compatibility:nextCompatibility,instructionRevision:'later-revision',agent:{instructions:'later instructions'}});
 await reopened.host.validateRecovery();
 expect((await reopened.host.runtime.harness.snapshot(AgentDoc,cid,context))?.instructions).toBe('later instructions');
});

it('refuses a legacy instruction transition with unfinished work and preserves its metadata',async()=>{
 const dir=await directory();await seedPending(dir);
 const before=await stateOf(dir);
 const next=await open(dir,'v1',{compatibility:{...compatibility,releaseSchema:2,registrySignature:'new'},previousCompatibility:compatibility,instructionRevision:'new',agent:{instructions:'new'}});
 await expect(next.host.validateRecovery()).rejects.toThrow('settled');
 expect(next.calls).toEqual({transportStart:0,sends:0,reconcileSources:0});
 await next.host.close();expect(await stateOf(dir)).toEqual(before);
});

it('rejects mismatched legacy proof rather than replacing metadata',async()=>{
 const dir=await directory();const first=await open(dir,'v1');await first.host.close();
 await expect(open(dir,'v1',{compatibility:{...compatibility,releaseSchema:2,registrySignature:'new'},previousCompatibility:{...compatibility,registrySignature:'wrong'},instructionRevision:'new'})).rejects.toThrow('Incompatible');
 const original=await open(dir,'v1');await original.host.validateRecovery();
});

it('does not apply new instructions across an uncertain external delivery',async()=>{
 const {Deliveries}=await import('../../src/durable/delivery.js');
 const dir=await directory();const first=await open(dir,'v1',{instructionRevision:'old',agent:{instructions:'old'}});
 await first.host.runtime.root.commit(async tx=>{(await tx.doc(Deliveries,first.host.runtime.root.id)).items.synthetic={target:{chatId:10},segments:[{text:'synthetic',status:'uncertain'}]};},context);
 await first.host.close();
 const next=await open(dir,'v1',{instructionRevision:'new',agent:{instructions:'new'}});
 await expect(next.host.start()).rejects.toThrow('settled');expect(next.calls.transportStart).toBe(0);
});

it.each([1,2])('schedule-management upgrade accepts only an exact settled predecessor (schema %s)',async releaseSchema=>{
 const dir=await directory();const old={...compatibility,releaseSchema};
 const first=await open(dir,'v1',{compatibility:old,instructionRevision:'old-text'});
 const rootId=first.host.runtime.root.id;await first.host.close();
 const next={...compatibility,releaseSchema:2,registrySignature:'scoped-schedule-client'};
 const candidate=await open(dir,'v1',{compatibility:next,instructionRevision:'new-text',scheduleUpgradeCompatibilities:[old]});
 expect((await candidate.host.inspect()).compatibility).toEqual(old);
 await candidate.host.validateRecovery();
 expect((await candidate.host.inspect()).compatibility).toEqual(next);
 expect(candidate.host.runtime.root.id).toBe(rootId);
 expect(candidate.calls.transportStart).toBe(0);
 await candidate.host.close();
 const reopened=await open(dir,'v1',{compatibility:next,instructionRevision:'new-text'});
 expect((await reopened.host.inspect()).compatibility).toEqual(next);
});
it('schedule-management upgrade preserves pending work and refuses to activate it under changed authority',async()=>{
 const dir=await directory();await seedPending(dir);
 const next={...compatibility,releaseSchema:2,registrySignature:'scoped-schedule-client'};
 const candidate=await open(dir,'v1',{compatibility:next,instructionRevision:'new-text',scheduleUpgradeCompatibilities:[compatibility]});
 await expect(candidate.host.validateRecovery()).rejects.toThrow(/settled work/);
 expect((await candidate.host.inspect()).compatibility).toEqual(compatibility);
 expect(candidate.calls.transportStart).toBe(0);expect(candidate.seen).toEqual([]);
});
it('schedule-management upgrade rejects a changed predecessor signature',async()=>{
 const dir=await directory();const first=await open(dir,'v1');await first.host.close();
 await expect(open(dir,'v1',{compatibility:{...compatibility,releaseSchema:2,registrySignature:'new'},instructionRevision:'new-text',scheduleUpgradeCompatibilities:[{...compatibility,registrySignature:'forged'}]})).rejects.toThrow(/Incompatible/);
});
