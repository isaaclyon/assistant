import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [compiled, root, kind, phase] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(compiled, path)).href);
const { startNativeJobsCoordinator } = await load('src/durable/coordinator.js');
const { enqueueJobHandoff, cancelJobHandoff } = await load('src/job-handoff.js');
const HOUR = 3_600_000;
const clock = { ms: Date.parse('2026-07-18T10:00:00.000Z') };
const stateRoot = join(root, 'state');
const coordinatorStateDir = join(root, 'coordinator');

const paused = async () => {
  await appendFile(join(root, 'barriers'), `${kind}:${phase}\n`);
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
  cancel: cancelJobHandoff,
};
const incremental = (since, ...ids) => ({
  ok: true,
  stdout: JSON.stringify({ version: 2, value: { items: ids.map((id) => ({ id, subject: `Subject ${id}` })) }, cursor: { since } }),
});
let reads = 0;
const runCheck = async () => { reads += 1; return reads === 1 ? incremental(1) : incremental(2, 'a'); };
const judge = async () => ({ model: 'synthetic', probabilities: { item_0: 0.9 } });
const heartbeat = {
  id: 'inbox', type: 'heartbeat', schedule: '0 * * * *', tz: 'UTC', target: 'emma',
  checker: { id: 'gmail-inbox', mode: 'incremental', args: { account: 'synthetic@example.test', timeZone: 'UTC' } },
  rule: { type: 'semantic-match', question: 'Does {item} need action?', criteria: { true: 'Action needed', false: 'No action' }, notifyAt: 0.5 },
  onTrigger: { type: 'prompt', prompt: 'Review the change' },
};
const hook = { id: 'hook', type: 'webhook', prompt: 'Handle it', target: 'emma' };
const schedules = kind === 'heartbeat' ? { checkerIds: ['gmail-inbox'] } : { checkerIds: [], webhook: { port: 8123 } };
await writeFile(join(coordinatorStateDir, 'jobs.json'), `${JSON.stringify({ version: 3, jobs: [kind === 'heartbeat' ? heartbeat : hook] })}\n`);
const coordinator = await startNativeJobsCoordinator({
  instanceId: 'isaac',
  stateDir: join(stateRoot, 'instances', 'isaac'),
  coordinator: { stateRoot, coordinatorStateDir, targets: ['isaac', 'emma'], scope: 'shared-owner', schedules },
  google: { account: 'synthetic@example.test', gog: { binary: '/opt/gog', passwordFile: '/secrets/gog', home: '/gog-home' } },
}, {
  logger: { info() {}, warn() {}, error(m) { console.error(m); } },
  nowMs: () => clock.ms,
  publication,
  schedules: kind === 'heartbeat' ? { runCheck, judge } : { webhookPort: 0 },
});
if (kind === 'heartbeat') {
  clock.ms += HOUR;
  await coordinator.tick(); // baseline, no event
  clock.ms += HOUR;
  await coordinator.tick(); // finds the item, persists cursor and pending event, then hits the barrier
  console.error('barrier was not reached');
  process.exit(3);
}
process.send?.({ type: 'ready', port: coordinator.webhookPort() });
await new Promise(() => {});
