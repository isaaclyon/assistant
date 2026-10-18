// Runs the real native application with a gate-writing fictional browser service until SIGKILL.
// The service sends an IPC 'paused' marker at the chosen boundary.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [compiled, directory, tool, phase] = process.argv.slice(2);
const f = await import(pathToFileURL(join(compiled, 'tests/durable/browser-crash-fixture.js')).href);
const s = await f.browserFixture(directory, { pause: true });
await s.pauseAt(phase);
await s.open([f.call(tool, f.toolArgs[tool]), () => f.done('WORKER_DONE')]);
process.send?.({ type: 'started' });
await s.accept('Sign me in.', 1);
await new Promise(() => { setInterval(() => {}, 1000); });
