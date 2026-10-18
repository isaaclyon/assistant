import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [compiled, path, mode] = process.argv.slice(2);
const load = file => import(pathToFileURL(join(compiled, file)).href);
const { placesCrashFixture, origin } = await load('tests/durable/places-crash-fixture.js');
const { PlacesApplication } = await load('src/places-application.js');
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
const fixture = await placesCrashFixture(path);
let pending;
// Pause synchronously inside the first start execute, which runs after the durable claim commit.
const original = PlacesApplication.prototype.execute;
PlacesApplication.prototype.execute = function (params) {
  if (params?.action !== (mode.endsWith('-input') ? 'create_category' : 'start')) return original.call(this, params);
  if (mode.startsWith('before')) { send({ event: 'paused', phase: 'before', ...pending }); block(); }
  const result = original.call(this, params);
  if (mode.startsWith('after')) { send({ event: 'paused', phase: 'after', ...pending }); block(); }
  return result;
};
let n = 0; const id = () => `worker-${++n}`;
await fixture.places.command(origin(id()));
const find = label => { const view = fixture.latest(); const request = fixture.press(label, view); return { ...request, messageId: view.messageId }; };
if (mode.endsWith('-input')) {
  await fixture.places.callback({ ...origin(id(), fixture.latest().messageId), ...find(/new category/i) });
  pending = { commandId: id(), messageId: 5000, replyToMessageId: fixture.latest().messageId, text: 'Crash Category' };
  await fixture.places.input({ ...origin(pending.commandId), ...pending });
} else {
await fixture.places.callback({ ...origin(id(), fixture.latest().messageId), ...find(/add place/i) });
const prompt = fixture.latest();
await fixture.places.input({ ...origin(id(), 5000), messageId: 5000, replyToMessageId: prompt.messageId, text: 'Crash Cafe' });
await fixture.places.callback({ ...origin(id(), fixture.latest().messageId), ...find(/restaurants/i) });
// The final press is the one the parent resends after the kill.
pending = { ...find(/liked/i), commandId: id() };
await fixture.places.callback({ ...origin(pending.commandId, pending.messageId), ...pending });
}
await send({ event: 'completed-unexpectedly' });
await new Promise(() => {});
