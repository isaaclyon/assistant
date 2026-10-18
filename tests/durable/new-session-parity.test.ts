import { afterEach, expect, test } from 'vitest';
import { cleanup, setup } from './parity-application-fixture.js';
import { Bindings, context } from '../../src/durable/ingress.js';
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
test('actual Telegram /new replay retains one epoch change across application restart', async () => {
 const s = await setup('durable-chat-memory-test'); await s.open();
 const epoch = async () => (await s.app()!.host.runtime.harness.snapshot(Bindings, s.app()!.host.runtime.root.id, context))!.epoch;
 await s.accept('/new', undefined, 42, 99); expect(await epoch()).toBe(1);
 await s.accept('/new', undefined, 42, 99); expect(await epoch()).toBe(1);
 await s.close(); await s.open();
 await s.accept('/new', undefined, 42, 99); expect(await epoch()).toBe(1);
 await s.accept('/new', undefined, 42, 100); expect(await epoch()).toBe(2); expect(s.requests).toEqual([]); expect(s.fatal).toEqual([]);
});
