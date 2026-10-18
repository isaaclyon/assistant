// Runs the real native application until a SIGKILL. Coordination is by files in the fixture directory:
// fake-gog writes paused.json at the Calendar transport effect; the places pause writes it from a domain wrapper.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const [compiled, directory, scenario, phase] = process.argv.slice(2);
const load = file => import(pathToFileURL(join(compiled, file)).href);
const f = await load('tests/durable/mutations-crash-fixture.js');
const s = await f.mutationsFixture(directory);
const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
const forever = () => new Promise(() => {});
const ready = value => writeFileSync(join(directory, 'ready.json'), JSON.stringify(value));
const methods = { create: 'events.insert', update: 'events.patch', delete: 'events.delete' };
const calendarTool = (args, final = 'WORKER_DONE') => f.call('google_workspace', args);
if (scenario === 'calendar-create' || scenario === 'calendar-update') {
  const kind = scenario.slice('calendar-'.length);
  await s.pauseAt(methods[kind], phase);
  await s.open([calendarTool(kind === 'create' ? f.createArgs : f.updateArgs), () => f.done('WORKER_DONE')]);
  await s.accept('Please change my calendar.', 1);
} else if (scenario === 'calendar-delete') {
  await s.open([calendarTool(f.deleteRequestArgs), () => f.done('ASKED')]);
  await s.accept('Delete my event.', 1);
  while (!s.presentations.length) await new Promise(r => setTimeout(r, 25));
  const view = s.latest(), data = s.button(/delete|confirm/i, view);
  await s.pauseAt(methods.delete, phase);
  ready({ messageId: view.messageId, data, updateId: 2 });
  await s.callback(view.messageId, data, 2);
} else if (scenario === 'places-delete') {
  const { PlacesApplication } = await load('src/places-application.js');
  const original = PlacesApplication.prototype.confirmPrepared;
  PlacesApplication.prototype.confirmPrepared = function (prepared) {
    const mark = () => writeFileSync(join(directory, 'paused.json'), JSON.stringify({ pid: process.pid, method: 'places.confirmPrepared', phase }), { flag: 'wx' });
    if (phase === 'before') { mark(); block(); }
    const result = original.call(this, prepared);
    if (phase === 'after') { mark(); block(); }
    return result;
  };
  const place = s.places().find(p => p.name === 'Crash Cafe');
  await s.open([f.call('rank_places', { action: 'request_confirmation', confirmation_operation: 'delete_place', place_id: place.id }), () => f.done('ASKED')]);
  await s.accept('Delete Crash Cafe.', 1);
  while (!s.presentations.length) await new Promise(r => setTimeout(r, 25));
  const view = s.latest(), data = s.button(/confirm|delete/i, view);
  ready({ messageId: view.messageId, data, updateId: 2 });
  await s.callback(view.messageId, data, 2);
} else throw new Error(`Unknown scenario ${scenario}`);
await forever();
