import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { DurableHost, type HostConfig } from '../../src/durable/host.js';
import { Bindings, accept, context, fingerprint, sourceKey, type SourceEnvelope } from '../../src/durable/ingress.js';
import { JobAdmissions, inspectJobHandoffs, jobEnvelope, reconcileJobHandoffs } from '../../src/durable/job-admission.js';
import type { FinalRequest } from '../../src/durable/delivery.js';
import { MAX_HANDOFF_PROMPT_BYTES, cancelJobHandoff, enqueueJobHandoff } from '../../src/job-handoff.js';
import { MediaOutbox } from '../../src/durable/media-outbound.js';
import { inspectScheduledCompletion } from '../../src/durable/canary-proof.js';
import { parseCanaryCompletionProof } from '../../src/durable/activation.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const INSTANCE = 'recipient', PRINCIPAL = 'person', BOT = 'bot', TARGET = { chatId: 10, threadId: 2 };
const NOW = new Date('2026-05-01T12:00:00.000Z');

async function dirs() {
  const base = await mkdtemp(join(tmpdir(), 'job-admission-'));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const stateRoot = join(base, 'root'), stateDir = join(stateRoot, 'instances', INSTANCE), coordinator = join(base, 'coordinator');
  await mkdir(stateDir, { recursive: true, mode: 0o700 }); await mkdir(coordinator, { mode: 0o700 });
  return { base, stateRoot, stateDir, coordinator, native: join(base, 'native'), handoffs: join(stateDir, 'job-handoffs') };
}
const enqueue = (d: Awaited<ReturnType<typeof dirs>>, over: { eventId?: string; prompt?: string; jobId?: string } = {}) =>
  enqueueJobHandoff({ stateRoot: d.stateRoot, coordinatorStateDir: d.coordinator, eventId: over.eventId ?? 'event-1', jobId: over.jobId ?? 'daily', jobType: 'cron', target: INSTANCE, prompt: over.prompt ?? 'Summarize the day', now: () => NOW });

async function host(d: Awaited<ReturnType<typeof dirs>>, responses = [answer('DONE')], over: Partial<HostConfig> = {}) {
  const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel(); const sent: FinalRequest[] = [];
  const conversations: unknown[] = [];
  const policy = (e: SourceEnvelope) => { if (e.principal !== PRINCIPAL || e.instance !== INSTANCE || e.bot !== BOT) throw new Error('Unauthorized'); };
  let job: HostConfig['reconcileSources'];
  const h = await DurableHost.create({
    stateDir: d.native, models, registry: createRegistry(), agent: { model: { provider: model.provider, modelId: model.id }, instructions: 'Synthetic' },
    compatibility: { runtimeGeneration: 'pi-durable-1.3.0', releaseSchema: 1, profile: 'fixture', registrySignature: 'fixture-v1' },
    transport: { async start() {}, async stop() {}, async sendFinal(r) { sent.push(r); return { messageId: sent.length }; } },
    policy, controlPolicy: () => {}, settings: { retry: { enabled: false }, compaction: { enabled: false } },
    reconcileSources: runtime => job!(runtime), ...over,
  });
  const results: Awaited<ReturnType<typeof reconcileJobHandoffs>>[] = [];
  job = async runtime => { results.push(await reconcileJobHandoffs({ runtime, stateDir: d.stateDir, instanceId: INSTANCE, principal: PRINCIPAL, bot: BOT, target: TARGET, policy, onConversation: async cid => { conversations.push(cid); } })); };
  cleanup.push(() => h.close());
  const last = () => ({ admitted: results.reduce((n, r) => n + r.admitted, 0), resumed: results.reduce((n, r) => n + r.resumed, 0), quarantined: results.flatMap(r => r.quarantined), held: results.flatMap(r => r.held) });
  return { h, faux, sent, results, conversations, last };
}
const list = (d: Awaited<ReturnType<typeof dirs>>, state: string) => readdir(join(d.handoffs, state)).catch(() => [] as string[]);
const receipts = async (h: DurableHost) => (await h.runtime.harness.snapshot(JobAdmissions, h.runtime.root.id, context))?.receipts ?? {};
async function pendingFile(d: Awaited<ReturnType<typeof dirs>>, name: string, content: string | object, mode = 0o600) {
  await mkdir(join(d.handoffs, 'pending'), { recursive: true, mode: 0o700 }); await chmod(d.handoffs, 0o700);
  const path = join(d.handoffs, 'pending', name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), { mode }); await chmod(path, mode);
  return path;
}

it('admits an enqueued job once, completes the v1 file on admission, and records the run separately', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d);
  const { h, faux, sent, conversations, last } = await host(d);
  await h.start(); await h.reconcile();
  expect(last().admitted + (await list(d, 'completed')).length).toBeGreaterThan(0);
  expect(await list(d, 'completed')).toEqual([`${dispatchId}.json`]); expect(await list(d, 'pending')).toEqual([]);
  const stored = JSON.parse(await readFile(join(d.handoffs, 'completed', `${dispatchId}.json`), 'utf8'));
  expect(stored.attempts).toBe(1);
  const receipt = (await receipts(h))[dispatchId]!;
  const envelope = jobEnvelope({ dispatchId, jobId: 'daily', jobType: 'cron', prompt: 'Summarize the day', createdAt: NOW.toISOString() }, { instanceId: INSTANCE, principal: PRINCIPAL, bot: BOT, target: TARGET });
  expect(receipt).toMatchObject({ sourceKey: sourceKey(envelope), requestId: sourceKey(envelope), admission: 'admitted' });
  expect(conversations).toContain(receipt.cid);
  const submission = (await h.runtime.harness.submission(receipt.submissionId!, context))!; await submission.wait(context);
  await h.reconcile(); await h.reconcile();
  expect((await receipts(h))[dispatchId]!.run).toBe('done');
  expect(faux.state.callCount).toBe(1); expect(sent.map(s => s.text)).toEqual(['DONE']);
  expect(sent[0]!.target).toEqual(TARGET);
  expect(await list(d, 'completed')).toEqual([`${dispatchId}.json`]);
  const proof=await inspectScheduledCompletion(h.runtime,dispatchId);
  expect(proof).toMatchObject({dispatchId,submissionId:receipt.submissionId,outcome:'done',createdAt:NOW.getTime()});
  expect(parseCanaryCompletionProof(proof,{instanceId:INSTANCE,dispatchId,initialReadyAt:NOW.getTime()-1})).toMatchObject({submissionId:String(receipt.submissionId),outcome:'done'});
  expect(faux.state.callCount).toBe(1);
  for(const status of ['queued','sending','uncertain'] as const){
   await h.runtime.root.commit(async tx=>{(await tx.doc(MediaOutbox,h.runtime.root.id)).items['synthetic-media']={files:[{status,notice:'done'} as never]};},context);
   await expect(inspectScheduledCompletion(h.runtime,dispatchId)).rejects.toThrow(/uncertain media/);
  }
  await h.runtime.root.commit(async tx=>{delete (await tx.doc(MediaOutbox,h.runtime.root.id)).items['synthetic-media'];},context);
  await h.runtime.root.commit(async tx=>{(await tx.doc(JobAdmissions,h.runtime.root.id)).receipts[dispatchId]!.run='pending';},context);
  await expect(inspectScheduledCompletion(h.runtime,dispatchId)).rejects.toThrow(/completed native admission/);
});

it('admits a maximum-size prompt whose JSON escaping expands the file', async () => {
  const d = await dirs();
  const { dispatchId } = await enqueue(d, { prompt: "\u0001".repeat(MAX_HANDOFF_PROMPT_BYTES) });
  const { h, faux } = await host(d);
  await h.start(); await h.reconcile();
  expect(await list(d, 'completed')).toEqual([`${dispatchId}.json`]);
  expect(await list(d, 'failed')).toEqual([]);
  expect(faux.state.callCount).toBe(1);
});

it('deduplicates repeated publication and never reprocesses a completed dispatch', async () => {
  const d = await dirs(); const first = await enqueue(d); const again = await enqueue(d);
  expect(again.dispatchId).toBe(first.dispatchId);
  const { h, faux } = await host(d); await h.start(); await h.reconcile();
  await enqueue(d); await h.reconcile(); await h.reconcile();
  expect(await list(d, 'pending')).toEqual([]); expect(faux.state.callCount).toBe(1);
  expect(Object.keys(await receipts(h))).toEqual([first.dispatchId]);
});

it('quarantines a changed payload for an already-bound dispatch without admitting it', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d);
  const { h, faux } = await host(d); await h.start(); await h.reconcile();
  // Settle the original run before snapshotting. Legitimate pending -> done
  // progress must not race the assertion that the conflicting payload changed nothing.
  const admitted = (await receipts(h))[dispatchId]!;
  await (await h.runtime.harness.submission(admitted.submissionId!, context))!.wait(context);
  await h.reconcile();
  const before = (await receipts(h))[dispatchId]!;
  expect(before.run).toBe('done');
  await pendingFile(d, `${dispatchId}.json`, { version: 1, dispatchId, jobId: 'daily', target: INSTANCE, prompt: 'Different prompt', createdAt: NOW.toISOString() });
  // The completed copy exists; a pending copy is a conflicting duplicate, and an altered prompt is a payload conflict.
  await h.reconcile(); await h.reconcile();
  expect(await list(d, 'pending')).toEqual([]);
  expect((await list(d, 'failed')).length).toBe(1);
  expect(await receipts(h)).toEqual({ [dispatchId]: before });
  expect(faux.state.callCount).toBe(1);
});

it('quarantines a conflicting pending payload when the receipt already exists but no v1 file does', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d);
  const { h, results } = await host(d); await h.start(); await h.reconcile();
  await rename(join(d.handoffs, 'completed', `${dispatchId}.json`), join(d.base, 'moved.json'));
  await pendingFile(d, `${dispatchId}.json`, { version: 1, dispatchId, jobId: 'daily', target: INSTANCE, prompt: 'Changed', createdAt: NOW.toISOString() });
  await h.reconcile();
  expect(results.at(-1)!.quarantined).toEqual([`${dispatchId}.json: conflicting payload for dispatch`]);
  expect((await receipts(h))[dispatchId]!.admission).toBe('admitted');
});

it.each([
  ['malformed JSON', 'daily-0123456789abcdef.json', '{nope', 0o600],
  ['unknown field', 'daily-0123456789abcdef.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: INSTANCE, prompt: 'x', createdAt: NOW.toISOString(), extra: true }, 0o600],
  ['wrong target', 'daily-0123456789abcdef.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: 'someone-else', prompt: 'x', createdAt: NOW.toISOString() }, 0o600],
  ['unsafe target text', 'daily-0123456789abcdef.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: '../x', prompt: 'x', createdAt: NOW.toISOString() }, 0o600],
  ['invalid source time', 'daily-0123456789abcdef.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: INSTANCE, prompt: 'x', createdAt: '1960-01-02T03:04:05.000Z' }, 0o600],
  ['broad mode', 'daily-0123456789abcdef.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: INSTANCE, prompt: 'x', createdAt: NOW.toISOString() }, 0o644],
  ['filename mismatch', 'daily-fedcba9876543210.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: INSTANCE, prompt: 'x', createdAt: NOW.toISOString() }, 0o600],
  ['oversized prompt', 'daily-0123456789abcdef.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: INSTANCE, prompt: 'x'.repeat(33 * 1024), createdAt: NOW.toISOString() }, 0o600],
  ['exhausted attempts', 'daily-0123456789abcdef.json', { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: INSTANCE, prompt: 'x', createdAt: NOW.toISOString(), attempts: 5 }, 0o600],
] as const)('quarantines %s visibly and admits nothing', async (_label, name, content, mode) => {
  const d = await dirs(); const { h, faux, last } = await host(d); await pendingFile(d, name, content, mode);
  await h.start(); await h.reconcile();
  expect(await list(d, 'pending')).toEqual([]); expect(last().quarantined).toHaveLength(1);
  expect((await list(d, 'failed')).length).toBe(1); expect(await receipts(h)).toEqual({}); expect(faux.state.callCount).toBe(0);
});

it('quarantines symlinks, hard links and directories in pending, leaving link targets untouched', async () => {
  const d = await dirs(); const { h, faux, last } = await host(d);
  const valid = { version: 1, dispatchId: 'daily-0123456789abcdef', jobId: 'daily', target: INSTANCE, prompt: 'x', createdAt: NOW.toISOString() };
  const outside = join(d.base, 'outside.json'); await writeFile(outside, JSON.stringify(valid), { mode: 0o600 });
  await pendingFile(d, 'daily-aaaaaaaaaaaaaaaa.json', ''); await rm(join(d.handoffs, 'pending', 'daily-aaaaaaaaaaaaaaaa.json'));
  await symlink(outside, join(d.handoffs, 'pending', 'daily-aaaaaaaaaaaaaaaa.json'));
  await link(outside, join(d.handoffs, 'pending', 'daily-0123456789abcdef.json'));
  await mkdir(join(d.handoffs, 'pending', 'daily-bbbbbbbbbbbbbbbb.json'));
  await h.start(); await h.reconcile();
  expect(last().quarantined.sort()).toEqual([
    'daily-0123456789abcdef.json: hard-linked file', 'daily-aaaaaaaaaaaaaaaa.json: not a regular file', 'daily-bbbbbbbbbbbbbbbb.json: not a regular file',
  ]);
  expect(await readFile(outside, 'utf8')).toBe(JSON.stringify(valid)); expect(faux.state.callCount).toBe(0);
});

it('holds every action when the handoff root is a symlink', async () => {
  const d = await dirs(); const elsewhere = join(d.base, 'elsewhere'); await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, d.handoffs);
  const { h, last } = await host(d); await h.start(); await h.reconcile();
  expect(last().held[0]).toContain('not a real directory'); expect(await readdir(elsewhere)).toEqual([]);
});

it('holds historical processing evidence without a native receipt and never replays it', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d);
  await mkdir(join(d.handoffs, 'processing'), { recursive: true, mode: 0o700 });
  await rename(join(d.handoffs, 'pending', `${dispatchId}.json`), join(d.handoffs, 'processing', `${dispatchId}.json`));
  const { h, faux, last } = await host(d); await h.start(); await h.reconcile(); await h.reconcile();
  expect([...new Set(last().held)]).toEqual([`${dispatchId}.json: processing without native reservation`]);
  expect(await list(d, 'processing')).toEqual([`${dispatchId}.json`]); expect(faux.state.callCount).toBe(0); expect(await receipts(h)).toEqual({});
});

it('resumes a native-owned claim after lost admission, with the exact stable source', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d); const first = await host(d);
  await first.h.start(); await first.h.reconcile(); const original = (await receipts(first.h))[dispatchId]!;
  await (await first.h.runtime.harness.submission(original.submissionId!, context))!.wait(context); await first.h.reconcile();
  // Simulate a crash after the claim and native submit but before the receipt and the v1 move.
  await rename(join(d.handoffs, 'completed', `${dispatchId}.json`), join(d.handoffs, 'processing', `${dispatchId}.json`));
  await first.h.runtime.root.commit(async tx => { const r = (await tx.doc(JobAdmissions, first.h.runtime.root.id)).receipts[dispatchId]!; r.admission = 'reserved'; delete r.submissionId; }, context);
  await first.h.close();
  const next = await host(d); await next.h.start(); await next.h.reconcile();
  const resumed = (await receipts(next.h))[dispatchId]!;
  expect(next.last().resumed).toBe(1); expect(resumed).toMatchObject({ admission: 'admitted', cid: original.cid, submissionId: original.submissionId, sourceKey: original.sourceKey });
  expect(await list(d, 'completed')).toEqual([`${dispatchId}.json`]); expect(await list(d, 'processing')).toEqual([]);
  expect(next.faux.state.callCount).toBe(0);
});

it('quarantines a processing file whose payload differs from the native reservation', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d); const first = await host(d);
  await first.h.start(); await first.h.reconcile(); await first.h.close();
  const path = join(d.handoffs, 'processing', `${dispatchId}.json`);
  await rename(join(d.handoffs, 'completed', `${dispatchId}.json`), path);
  const body = JSON.parse(await readFile(path, 'utf8')); await writeFile(path, JSON.stringify({ ...body, prompt: 'tampered' }));
  const next = await host(d, [answer('NO')]); await next.h.start(); await next.h.reconcile();
  expect(next.last().quarantined).toEqual([`${dispatchId}.json: conflicting payload for dispatch`]); expect(next.faux.state.callCount).toBe(0);
});

it('does not cancel a claimed or admitted run, and a cancelled pending dispatch is never admitted', async () => {
  const d = await dirs(); const kept = await enqueue(d, { eventId: 'kept' }); const dropped = await enqueue(d, { eventId: 'dropped', prompt: 'Other' });
  expect(await cancelJobHandoff({ stateRoot: d.stateRoot, coordinatorStateDir: d.coordinator, dispatchId: dropped.dispatchId, jobId: 'daily', target: INSTANCE })).toEqual({ [INSTANCE]: 'cancelled' });
  const { h, faux } = await host(d); await h.start(); await h.reconcile();
  expect(await cancelJobHandoff({ stateRoot: d.stateRoot, coordinatorStateDir: d.coordinator, dispatchId: kept.dispatchId, jobId: 'daily', target: INSTANCE })).toEqual({ [INSTANCE]: 'completed' });
  expect(Object.keys(await receipts(h))).toEqual([kept.dispatchId]);
  await (await h.runtime.harness.submission((await receipts(h))[kept.dispatchId]!.submissionId!, context))!.wait(context);
  expect(faux.state.callCount).toBe(1); expect(await list(d, 'cancelled')).toEqual([`${dropped.dispatchId}.json`]);
});

it('reports a held lock instead of failing the host line, then admits once it is released', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d);
  const { withMutationLock } = await import('../../.pi/lib/mutation-lock.mjs');
  const { h, results } = await host(d);
  const gate = Promise.withResolvers<void>(), locked = Promise.withResolvers<void>();
  const holder = withMutationLock(join(d.handoffs, '.drain-lock.sqlite'), async () => { locked.resolve(); await gate.promise; });
  await locked.promise; await h.start(); gate.resolve(); await holder;
  expect(results[0]!.held).toEqual(['job-handoffs: another drain, cancel or recovery holds the lock']); expect(results[0]!.admitted).toBe(0);
  expect(await list(d, 'pending')).toEqual([`${dispatchId}.json`]);
  await h.reconcile(); expect(await list(d, 'completed')).toEqual([`${dispatchId}.json`]);
}, 30_000);

it('suppresses a proactive NO_REPLY job answer and leaves the human idle clock untouched', async () => {
  const d = await dirs(); const { dispatchId } = await enqueue(d);
  const { h, sent } = await host(d, [answer('NO_REPLY')], { idleMs: 1000 });
  await h.start(); await h.reconcile();
  await (await h.runtime.harness.submission((await receipts(h))[dispatchId]!.submissionId!, context))!.wait(context);
  await h.reconcile(); expect(sent).toEqual([]);
  const state = (await h.runtime.harness.snapshot(Bindings, h.runtime.root.id, context))!;
  expect(state.lastHumanAt).toBe(0); expect(state.epoch).toBe(0);
  const binding = Object.values(state.sources)[0]!; expect(binding).toMatchObject({ proactive: true, deliveryComplete: true });
  // A later human message long after the job still starts in the same (first) epoch: jobs never set the clock.
  await h.receive({ instance: INSTANCE, principal: PRINCIPAL, bot: BOT, ...TARGET, messageIds: [1], originalAt: NOW.getTime() + 10_000_000, content: 'hello' });
  expect((await h.runtime.harness.snapshot(Bindings, h.runtime.root.id, context))!.epoch).toBe(0);
});


it('quarantines malformed historical processing bytes while keeping valid unproved claims held',async()=>{
 const d=await dirs();const {dispatchId}=await enqueue(d);await mkdir(join(d.handoffs,'processing'),{mode:0o700});
 await rename(join(d.handoffs,'pending',`${dispatchId}.json`),join(d.handoffs,'processing',`${dispatchId}.json`));
 await writeFile(join(d.handoffs,'processing','malformed.json'),'{broken',{mode:0o600});
 const s=await host(d);await s.h.start();
 expect(s.last().quarantined).toEqual(['malformed.json: malformed JSON']);
 expect(s.last().held).toEqual([`${dispatchId}.json: processing without native reservation`]);
 expect(await inspectJobHandoffs({runtime:s.h.runtime,stateDir:d.stateDir})).toMatchObject({files:{processing:1,failed:1},heldClaims:1});
 expect(s.faux.state.callCount).toBe(0);
});

it('holds a non-private directory tree and exposes read-only counts without repairing permissions',async()=>{
 const d=await dirs();await enqueue(d);await chmod(d.handoffs,0o755);const s=await host(d);await s.h.start();
 expect(s.last().held.some(reason=>reason.includes('not private'))).toBe(true);
 expect(await inspectJobHandoffs({runtime:s.h.runtime,stateDir:d.stateDir})).toMatchObject({unsafeTree:true,admissions:{admitted:0}});
 expect(await list(d,'pending')).toHaveLength(1);expect(s.faux.state.callCount).toBe(0);
});

it('an explicit stop withdraws a native reserved source without inventing an admission receipt',async()=>{
 const d=await dirs();const {dispatchId}=await enqueue(d);const s=await host(d);
 const envelope=jobEnvelope({dispatchId,jobId:'daily',jobType:'cron',prompt:'Summarize the day',createdAt:NOW.toISOString()},{instanceId:INSTANCE,principal:PRINCIPAL,bot:BOT,target:TARGET});
 const accepted=await accept(s.h.runtime,envelope);await s.h.runtime.root.commit(async tx=>{(await tx.doc(JobAdmissions,s.h.runtime.root.id)).receipts[dispatchId]={fingerprint:fingerprint(envelope),sourceKey:sourceKey(envelope),requestId:sourceKey(envelope),cid:accepted.binding.conversationId,admission:'reserved',run:'pending'};},context);
 await mkdir(join(d.handoffs,'processing'),{mode:0o700});await rename(join(d.handoffs,'pending',`${dispatchId}.json`),join(d.handoffs,'processing',`${dispatchId}.json`));
 await s.h.stop('stop-job',PRINCIPAL,TARGET);await s.h.start();
 expect((await receipts(s.h))[dispatchId]).toMatchObject({admission:'cancelled'});
 expect(await inspectJobHandoffs({runtime:s.h.runtime,stateDir:d.stateDir})).toMatchObject({admissions:{cancelled:1},runs:{pending:0,done:0,unanswered:0}});
 expect(await list(d,'completed')).toEqual([]);expect(await list(d,'cancelled')).toEqual([`${dispatchId}.json`]);expect(s.faux.state.callCount).toBe(0);
});

it('bounds a single scan and leaves the remaining malformed work for the next reconcile',async()=>{
 const d=await dirs();await mkdir(join(d.handoffs,'pending'),{recursive:true,mode:0o700});
 await Promise.all(Array.from({length:101},(_,i)=>writeFile(join(d.handoffs,'pending',`bad-${i}.json`),'{broken',{mode:0o600})));
 const s=await host(d);await s.h.start();expect(s.results[0]!.quarantined).toHaveLength(100);expect(s.results[0]!.held).toContain('pending: scan limit reached; remaining work waits');
 expect(await list(d,'pending')).toHaveLength(1);await s.h.reconcile();expect(await list(d,'pending')).toEqual([]);expect(s.faux.state.callCount).toBe(0);
});

const reserve = (s: Awaited<ReturnType<typeof host>>, dispatchId: string) => {
 const envelope=jobEnvelope({dispatchId,jobId:'daily',jobType:'cron',prompt:'Summarize the day',createdAt:NOW.toISOString()},{instanceId:INSTANCE,principal:PRINCIPAL,bot:BOT,target:TARGET});
 return s.h.runtime.root.commit(async tx=>{(await tx.doc(JobAdmissions,s.h.runtime.root.id)).receipts[dispatchId]={fingerprint:fingerprint(envelope),sourceKey:sourceKey(envelope),requestId:sourceKey(envelope),cid:null,admission:'reserved',run:'pending'};},context);
};

it('settles a reserved receipt cancelled by the legacy coordinator before claim, without submitting',async()=>{
 const d=await dirs();const {dispatchId}=await enqueue(d);const s=await host(d);await reserve(s,dispatchId);
 expect(await cancelJobHandoff({stateRoot:d.stateRoot,coordinatorStateDir:d.coordinator,dispatchId,jobId:'daily',target:INSTANCE})).toEqual({[INSTANCE]:'cancelled'});
 await s.h.start();
 expect((await receipts(s.h))[dispatchId]).toMatchObject({admission:'cancelled',cid:null});
 expect(await list(d,'cancelled')).toEqual([`${dispatchId}.json`]);expect(s.faux.state.callCount).toBe(0);expect(s.results[0]!.cancelled).toBe(1);
});

it('holds a reserved receipt when the cancelled file is only a tombstone or a different payload',async()=>{
 const d=await dirs();const {dispatchId}=await enqueue(d);const s=await host(d);await reserve(s,dispatchId);
 await rm(join(d.handoffs,'pending',`${dispatchId}.json`));
 await cancelJobHandoff({stateRoot:d.stateRoot,coordinatorStateDir:d.coordinator,dispatchId,jobId:'daily',target:INSTANCE});
 await s.h.start();expect((await receipts(s.h))[dispatchId]).toMatchObject({admission:'reserved'});
 await rm(join(d.handoffs,'cancelled',`${dispatchId}.json`));
 await writeFile(join(d.handoffs,'cancelled',`${dispatchId}.json`),JSON.stringify({version:1,dispatchId,jobId:'daily',target:INSTANCE,prompt:'Other',createdAt:NOW.toISOString(),jobType:'cron',attempts:0}),{mode:0o600});
 await s.h.reconcile();expect((await receipts(s.h))[dispatchId]).toMatchObject({admission:'reserved'});expect(s.faux.state.callCount).toBe(0);
});

it('looks up at most 100 pending runs per pass and rotates so a younger run is not starved',async()=>{
 const d=await dirs();const {dispatchId}=await enqueue(d);const s=await host(d);await s.h.start();await s.h.reconcile();
 const real=(await receipts(s.h))[dispatchId]!;await (await s.h.runtime.harness.submission(real.submissionId!,context))!.wait(context);
 await s.h.runtime.root.commit(async tx=>{const doc=await tx.doc(JobAdmissions,s.h.runtime.root.id);
  for(let i=0;i<150;i++)doc.receipts[`aaa-${String(i).padStart(3,'0')}`]={...real,requestId:`missing-${i}`,run:'pending'};
  doc.receipts[dispatchId]!.run='pending';},context);
 const settled=async()=>(await receipts(s.h))[dispatchId]!.run;
 await s.h.reconcile();expect(await settled()).toBe('pending');
 await s.h.reconcile();expect(await settled()).toBe('done');
});

it('bounds reserved cancellation checks and rotates past missing old evidence',async()=>{
 const d=await dirs();const {dispatchId}=await enqueue(d);const s=await host(d);await reserve(s,dispatchId);
 await cancelJobHandoff({stateRoot:d.stateRoot,coordinatorStateDir:d.coordinator,dispatchId,jobId:'daily',target:INSTANCE});
 await s.h.runtime.root.commit(async tx=>{
  const doc=await tx.doc(JobAdmissions,s.h.runtime.root.id),real=doc.receipts[dispatchId]!;
  for(let i=0;i<150;i++)doc.receipts[`aaa-${String(i).padStart(3,'0')}`]={...real};
 },context);
 await s.h.start();expect((await receipts(s.h))[dispatchId]!.admission).toBe('reserved');
 await s.h.reconcile();expect((await receipts(s.h))[dispatchId]!.admission).toBe('cancelled');
 expect(s.faux.state.callCount).toBe(0);
});
