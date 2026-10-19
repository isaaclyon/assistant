import { open } from './memory-integration-runtime.js';
// argv: dir, note id, revision. Dies by SIGKILL right after the Markdown rename, before the native task records a result.
const [dir, id, revision] = process.argv.slice(2) as [string, string, string];
const app = await open(dir, { hooks: { afterMarkdown: () => { process.send?.({ event: 'effect' }); process.kill(process.pid, 'SIGKILL'); } } });
await app.call({ action: 'update', id, revision, append: 'crash-line\n' });
