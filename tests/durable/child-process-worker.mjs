// Fixture: runs the compiled production childMain with a faux provider. argv: compiled stateDir batchId jobId probeDir
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

const args = process.argv.slice(2);
let [compiled, stateDir, batchId, jobId, probe] = args;
if (args.length === 3) {
  [stateDir, batchId, jobId] = args;
  ({ compiled, probe } = JSON.parse(await readFile(join(process.cwd(), '.child-fixture.json'), 'utf8')));
}
const { childMain } = await import(pathToFileURL(join(compiled, 'src/durable/child-worker.js')).href);
const { name, file, marker } = JSON.parse(await readFile(join(probe, 'scenario.json'), 'utf8'));

const forever = (signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
const faux = fauxProvider({ tokensPerSecond: 1e9, tokenSize: { min: 1024, max: 1024 } });
const log = async (entry) => appendFile(join(probe, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
const seen = (ctx) => { const text = JSON.stringify(ctx.messages); return { tool: text.includes(marker), tasks: text.split('Task:\\n').length - 1 }; };
const read = () => answer(fauxToolCall('repo_read', { path: file }), { stopReason: 'toolUse' });
const steps = {
  report: [read, ctx => answer(`REPORT_OK tool=${seen(ctx).tool}`)],
  hang: [read, (_ctx, options) => forever(options?.signal)],
  resume: [ctx => answer(`RESUMED tool=${seen(ctx).tool}`)],
  'pre-disconnect': [read, ctx => answer(`REPORT_OK tool=${seen(ctx).tool}`)],
}[name];
faux.setResponses(steps.map((step, index) => async (ctx, options) => {
  await log({ name, index, pid: process.pid, cwd: process.cwd(), ...seen(ctx), env: Object.keys(process.env).sort() });
  return step(ctx, options);
}));
const models = createModels(); models.setProvider(faux.provider);
const model = faux.getModel();
const provider = { models, provider: faux.provider, model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off', close() {} };
if (name === 'pre-disconnect') {
  // Hold before entering the production function so the parent can deterministically
  // disconnect IPC. Record that the fixture reached the call with IPC already gone.
  await new Promise(resolve => {
    process.once('disconnect', resolve);
    process.send({ fixture: 'before-child-main' });
  });
  await writeFile(join(probe, 'entry.json'), JSON.stringify({ connected: process.connected }));
}
const code = await childMain([stateDir, batchId, jobId], { provider });
process.exit(code);
