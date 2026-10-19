import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [compiled, root, phase] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(compiled, path)).href);
const { startNativeJobsCoordinator } = await load('src/durable/coordinator.js');
const { enqueueJobHandoff, cancelJobHandoff } = await load('src/job-handoff.js');
const NOW = Date.parse('2023-11-14T22:13:20.000Z');
const stateRoot = join(root, 'state');
const stateDir = join(stateRoot, 'instances', 'isaac');
const job = (over = {}) => ({ id: 'reminder', type: 'at', at: '2023-11-14T00:00:00Z', prompt: 'Call the dentist', target: 'emma', ...over });
const writeJobs = (jobs) => writeFile(join(root, 'coordinator', 'jobs.json'), JSON.stringify({ version: 3, jobs }));
const paused = async () => {
  await appendFile(join(root, 'barriers'), `${phase}\n`);
  process.send?.({ type: 'paused' });
  await new Promise(() => {});
};
const publication = {
  enqueue: async (options) => {
    if (phase === 'materialized') await paused();
    const result = await enqueueJobHandoff(options);
    if (phase === 'published') await paused();
    return result;
  },
  cancel: async (options) => {
    if (phase === 'superseded') await paused();
    const result = await cancelJobHandoff(options);
    if (phase === 'cancelled') await paused();
    return result;
  },
};
await writeJobs([job()]);
const coordinator = await startNativeJobsCoordinator({
  instanceId: 'isaac',
  stateDir,
  coordinator: { stateRoot, coordinatorStateDir: join(root, 'coordinator'), targets: ['isaac', 'emma'], scope: 'shared-owner' },
}, { logger: { info() {}, warn() {}, error(m) { console.error(m); } }, nowMs: () => NOW, publication });
await coordinator.tick();
if (phase === 'superseded' || phase === 'cancelled') {
  await writeJobs([job({ prompt: 'Changed', at: '2999-01-01T00:00:00Z' })]);
  await coordinator.reload();
}
process.exit(3);
