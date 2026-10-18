// Fixture: seeds an expired terminal child batch, then pauses inside onTombstone until the parent SIGKILLs it.
// argv: compiled root batchId jobId
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension } from '@earendil-works/pi-durable';

const [compiled, root, batchId, jobId] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(compiled, path)).href);
const { DurableHost } = await load('src/durable/host.js');
const { createNativeChildren, NativeChildren } = await load('src/durable/children.js');
const { ChildArtifacts } = await load('src/durable/child-artifacts.js');
const { runNativeChild } = await load('src/durable/child-worker.js');
const { context } = await load('src/durable/ingress.js');

const stateDir = join(root, 'state'), workspace = join(root, 'workspace');
const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
faux.setResponses([answer('SEEDED_REPORT')]);
const models = createModels(); models.setProvider(faux.provider);
const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
const provider = { models, provider: faux.provider, model, thinkingLevel: 'off', close() {} };
const createdAt = 1_700_000_000_000, expiresAt = createdAt + 1_000;
const manifest = { version: 1, batchId, jobId, launchId: 'launch-retention', purpose: 'retention acceptance', createdAt, expiresAt, deadlineAt: createdAt + 60_000,
  endCondition: 'expiry', task: 'PRIVATE_TASK', context: '', model, thinkingLevel: 'off', roots: [workspace], workspaceCwd: workspace,
  provider: { credentialPath: '/unused', settingsPath: '/unused', account: 'test' } };
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const artifacts = new ChildArtifacts(stateDir);
await artifacts.prepare(manifest);
const outcome = await runNativeChild(artifacts.jobDir(batchId, jobId), manifest, { provider });
await artifacts.writeOutcome(outcome);

let host;
const config = { stateDir, workspaceCwd: workspace, resourceRoot: workspace, principal: 'isaac', instanceId: 'test', credentialPath: '/unused', settingsPath: '/unused', account: 'test', transport: { botId: 123, allowedUserId: 42 } };
const service = createNativeChildren({ config, host: () => host, provider, now: () => expiresAt + 1,
  supervisor: { run: async () => undefined, active: () => false, close: async () => {} },
  onTombstone: async () => { process.send({ type: 'paused' }); await new Promise(() => {}); } });
const registry = createRegistry();
registry.install(defineExtension({ name: 'retention-recovery', tasks: [service.jobTask, service.reportTask] }));
host = await DurableHost.create({ stateDir: join(root, 'main'), models, registry, agent: { model, instructions: 'Synthetic', cwd: workspace },
  compatibility: { runtimeGeneration: 't', releaseSchema: 1, profile: 't', registrySignature: 't' }, policy() {}, controlPolicy() {},
  transport: { async start() {}, async stop() {}, async sendFinal() { return { messageId: 1 }; } } });
await host.runtime.root.commit(async (tx) => {
  const doc = await tx.doc(NativeChildren, host.runtime.root.id);
  // The outcome is committed but its orchestration task has not run yet. After
  // SIGKILL, production jobTask recovery must settle without relaunching it.
  const taskId = await tx.createTask(service.jobTask, { batchId, jobId }, { ownership: { kind: 'conversation' }, conversationId: host.runtime.root.id, background: true, abandonOnRestart: false });
  doc.batches[batchId] = { id: batchId, createdAt, expiresAt,
    origin: { conversationId: host.runtime.root.id, epoch: 0, principal: 'isaac', chatId: 42, threadId: null, instance: 'test', bot: '123' },
    jobs: [{ id: jobId, launchId: manifest.launchId, taskId, status: 'completed', cancelRequested: false, finishedAt: createdAt }],
    report: { taskId: null, status: 'pending', text: null, sourceId: null }, tombstone: false, removed: false };
}, context);
await service.cleanup(true);
process.exit(3);
