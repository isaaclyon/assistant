import { open, prepare, approve } from './operations-runtime.js';
const app = await open(process.argv[2]!, { crash: true, missing: process.argv[3] === 'missing' });
await approve(app, await prepare(app));
app.harness.resume();
setInterval(() => {}, 1_000);
