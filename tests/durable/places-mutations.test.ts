import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import type { NativeConfig } from '../../src/durable/config.js';
import type { DurableHost } from '../../src/durable/host.js';
import { Bindings, context, fingerprint, sourceKey } from '../../src/durable/ingress.js';
import { PlacesNative, createNativePlaces } from '../../src/durable/places.js';
import type { Presentation } from '../../src/durable/telegram-ui.js';
import { UiRejectedError, type UiOrigin } from '../../src/durable/telegram-bridge.js';

type Sent = { messageId: number; text: string; buttons: Array<Array<{ text: string; callback: string }>> };

async function setup(options: { principal?: NativeConfig['principal'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'places-native-'));
  const stateDir = join(dir, 'state');
  const config = {
    version: 1, runtime: 'pi-durable', instanceId: 'test', principal: options.principal ?? 'isaac', releaseSha: 'a'.repeat(40),
    resourceRoot: join(dir, 'release'), workspaceCwd: join(dir, 'work'), stateDir,
    capabilityProfile: 'durable-mutations-test', account: 'test', credentialPath: '/x', settingsPath: '/x', jobsRole: 'disabled', idleHours: 0,
    transport: { mode: 'broker', socketPath: '/x.sock', botId: 1, allowedUserId: 2 },
    historyDir: join(stateDir, 'durable'), inboxPath: join(stateDir, 'inbox.db'), runtimeMetadataPath: join(stateDir, 'runtime.json'),
  } as NativeConfig;
  await import('node:fs/promises').then(fs => fs.mkdir(stateDir, { recursive: true }));
  const db = await openNodeSqliteDatabase(join(dir, 'native.sqlite'));
  const harness = await Harness.open(await SqliteStorage.open(db), { models: createModels(), registry: createRegistry() }, context);
  const root = await harness.root(context);
  const envelope = { instance: 'test', principal: config.principal, bot: 'bot', chatId: 2, messageIds: [1], originalAt: Date.now(), content: 'Manage my places' };
  await root.commit(async tx => {
    const state = await tx.doc(Bindings, root.id); state.epoch = 1; state.epochs['1'] = root.id;
    state.sources[sourceKey(envelope)] = { conversationId: root.id, epoch: 1, fingerprint: fingerprint(envelope),
      chatId: 2, threadId: null, originalAt: envelope.originalAt, principal: config.principal, proactive: false, envelope };
  }, context);
  const control = { time: Date.now(), commitGate: undefined as Promise<void> | undefined, failReceipt: false, failNextPresent: false, failCommit: undefined as undefined | ((n: number) => 'before' | 'after' | undefined), commits: 0, hostReady: true };
  const wrapped = {
    id: root.id,
    commit: (fn: (tx: never) => Promise<unknown>, ctx: never) => {
      const n = ++control.commits;
      const mode = control.failCommit?.(n);
      if (mode === 'before') return Promise.reject(new Error('crash before'));
      const run = mode === 'after' ? (async (tx: never) => { await fn(tx); throw new Error('crash after effect'); }) : fn;
      return root.commit(run as never, ctx);
    },
  };
  const host = { runtime: { root: wrapped } } as unknown as DurableHost;
  const sent: Sent[] = [];
  let next = 100;
  let places = createNativePlaces({
    config, now: () => control.time, host: () => { if (!control.hostReady) throw new Error('no host'); return host; },
    present: async (_target, presentation: Presentation) => {
      if (control.failNextPresent) { control.failNextPresent = false; throw new Error('telegram down'); }
      const messageId = ++next;
      sent.push({ messageId, text: presentation.text, buttons: (presentation.buttons ?? []) as Sent['buttons'] });
      return { messageId: control.failReceipt ? NaN : messageId };
    },
  });
  let counter = 0;
  const origin = (): UiOrigin => ({ commandId: `cmd-${++counter}`, principal: 'isaac', actorId: 2, target: { chatId: 2 } });
  const last = () => sent[sent.length - 1]!;
  const labels = (message: Sent = last()) => message.buttons.flat().map(button => button.text);
  const find = (label: string, message: Sent = last()) => {
    const button = message.buttons.flat().find(item => item.text === label);
    if (!button) throw new Error(`No button ${label}; have ${labels(message).join(', ')}`);
    return button.callback;
  };
  const press = (label: string, message: Sent = last(), request: Partial<UiOrigin> = {}) =>
    places.callback({ ...origin(), ...request, messageId: message.messageId, key: find(label, message).slice(3) });
  const reply = (text: string, to: Sent = last(), request: Partial<UiOrigin> = {}) =>
    places.input({ ...origin(), ...request, messageId: 900 + counter, replyToMessageId: to.messageId, text });
  type ActionRecord = { key: string; messageId: number | null; state: string; draftGen: number | null };
  const state = () => root.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(PlacesNative, root.id))) as { draft: { name: string; categoryId: string | null } | null; actions: Record<string, ActionRecord>; prompts: Record<string, { state: string }> }, context);
  return {
    dir, stateDir, config, root, harness, sent, control, last, labels, find, press, reply, origin, state, host,
    get places() { return places; },
    reopen: async () => { await places.close(); places = createNativePlaces({ config, now: () => control.time, host: () => host, present: async (_t, p) => { const messageId = ++next; sent.push({ messageId, text: p.text, buttons: (p.buttons ?? []) as Sent['buttons'] }); return { messageId }; } }); },
    api: { conversationId: root.id, commit: (fn: never, ctx: never) => root.commit(fn, ctx) },
    cleanup: async () => { await places.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
let fx: Fixture;
beforeEach(async () => { fx = await setup(); });
afterEach(async () => { await fx.cleanup(); });

const rejected = async (work: Promise<unknown>) => { try { await work; } catch (error) { expect(error).toBeInstanceOf(UiRejectedError); return (error as Error).message; } throw new Error('expected rejection'); };
async function tool(args: Record<string, unknown>) {
  const registration = fx.places.bundle().tools[0]!.tool as unknown as { execute(args: unknown, api: unknown, ctx: unknown): Promise<{ output: Array<{ text: string }>; isError?: boolean; control?: { terminate: boolean } }> };
  const result = await registration.execute(args, fx.api, context);
  return { ...JSON.parse(result.output[0]!.text), isError: result.isError, terminate: result.control?.terminate, raw: result.output[0]!.text };
}
async function addPlace(name: string, category: string, sentiment: 'Liked' | 'Alright' | 'Disliked' = 'Liked') {
  await fx.places.command(fx.origin());
  while (fx.last().text.includes('Which is better?')) await fx.press(fx.labels()[0]!);
  if (!fx.labels().includes('Add place')) await fx.places.command(fx.origin());
  await fx.press('Add place');
  expect(await fx.reply(name)).toBe(true);
  if (!fx.labels().includes(category)) { await fx.press('New category'); await fx.reply(category); }
  await fx.press(category);
  await fx.press(sentiment);
}
/** Opens the management view of a place from the menu. */
async function openManage(place: string, category = 'Pizza') {
  await fx.places.command(fx.origin());
  await fx.press('View rankings');
  await fx.press(fx.labels().find(label => label.startsWith(`${category} (`))!);
  await fx.press(place);
  await fx.press('Manage');
}
async function rankingNames(category = 'Pizza') {
  await fx.places.command(fx.origin());
  await fx.press('View rankings');
  await fx.press(fx.labels().find(label => label.startsWith(`${category} (`))!);
  return fx.last().text;
}

describe('direct confirmations', () => {
  test('delete place needs the Confirm button and then removes it once', async () => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha');
    await fx.press('Delete place');
    expect(fx.last().text).toContain('Delete Alpha?');
    expect(fx.labels()).toEqual(['Confirm', 'Cancel']);
    expect(await rankingNames()).toContain('Alpha');
    await openManage('Alpha'); await fx.press('Delete place');
    await fx.press('Confirm');
    expect(fx.last().text).toContain('Place deleted.');
    expect(await rankingNames()).toContain('No places ranked yet.');
  });

  test('Cancel changes nothing and voids the sibling Confirm', async () => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha'); await fx.press('Delete place');
    const view = fx.last();
    await fx.press('Cancel', view);
    expect(fx.last().text).toContain('Nothing was changed');
    expect(await rejected(fx.press('Confirm', view))).toMatch(/expired/);
    expect(await rankingNames()).toContain('Alpha');
  });

  test.each([['Confirm', 'Cancel'], ['Cancel', 'Confirm']])('concurrent %s and %s claim only one sibling', async (first, second) => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha'); await fx.press('Delete place');
    const preview = fx.last();
    const results = await Promise.allSettled([fx.press(first!, preview), fx.press(second!, preview)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(fx.last().text).toContain(first === 'Confirm' ? 'Place deleted.' : 'Nothing was changed');
    expect(await rankingNames()).toContain(first === 'Confirm' ? 'No places ranked yet.' : 'Alpha');
  });

  test('undo addition from the completed view removes the place; a changed category refuses it', async () => {
    await addPlace('Alpha', 'Pizza');
    const done = fx.last();
    expect(fx.labels(done)).toContain('Undo addition');
    await fx.press('Undo addition', done);
    expect(fx.last().text).toContain('Undo adding Alpha?');
    await fx.press('Confirm');
    expect(fx.last().text).toContain('Addition undone.');
    expect(await rankingNames()).toContain('No places ranked yet.');
    // Second addition, then a later addition changes the category before undo is confirmed.
    await addPlace('Alpha', 'Pizza');
    await fx.press('Undo addition');
    const preview = fx.last();
    await addPlace('Beta', 'Pizza');
    while (fx.last().text.includes('Which is better?')) await fx.press(fx.labels()[0]!);
    await fx.press('Confirm', preview);
    expect(fx.last().text).toMatch(/Undo is no longer available|no longer current/);
    expect(await rankingNames()).toContain('Alpha');
  });

  test('cancel ranking from a comparison discards the unfinished insertion', async () => {
    await addPlace('Alpha', 'Pizza');
    await addPlace('Beta', 'Pizza');
    expect(fx.last().text).toContain('Which is better?');
    await fx.press('Cancel ranking');
    expect(fx.last().text).toContain('unfinished ranking');
    await fx.press('Confirm');
    expect(fx.last().text).toContain('Ranking cancelled.');
    expect(fx.labels()).not.toContain('Cancel ranking');
    expect(await rankingNames()).not.toContain('Beta');
  });

  test('a stale comparison revision cannot be cancelled', async () => {
    await addPlace('Alpha', 'Pizza');
    await addPlace('Beta', 'Pizza');
    await addPlace('Gamma', 'Pizza').catch(() => {});
    const compare = fx.sent.filter(m => m.text.includes('Which is better?')).at(-1)!;
    await fx.press('Cancel ranking', compare);
    const preview = fx.last();
    await fx.press(fx.labels(compare)[0]!, compare).catch(() => {});
    await fx.press('Confirm', preview);
    expect(fx.last().text).not.toContain('Ranking cancelled.');
  });

  test('delete category: an empty category is removed, a changed one is refused', async () => {
    await fx.places.command(fx.origin()); await fx.press('New category'); await fx.reply('Ramen');
    await fx.places.command(fx.origin()); await fx.press('Manage categories'); await fx.press('Ramen');
    await fx.press('Delete category');
    expect(fx.last().text).toContain('Delete the empty category Ramen?');
    const stale = fx.last();
    await fx.press('Confirm');
    expect(fx.last().text).toContain('Category deleted.');
    expect(await rejected(fx.press('Confirm', stale))).toMatch(/already used|expired/);
    await fx.places.command(fx.origin()); await fx.press('View rankings');
    expect(fx.labels().some(label => label.startsWith('Ramen'))).toBe(false);
  });

  test('a category that changed after the preview keeps its place (stale snapshot)', async () => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha'); await fx.press('Delete place');
    const preview = fx.last();
    await addPlace('Beta', 'Pizza');
    while (fx.last().text.includes('Which is better?')) await fx.press(fx.labels()[0]!);
    await fx.press('Confirm', preview);
    expect(fx.last().text).toContain('no longer current');
    expect(await rankingNames()).toContain('Alpha');
  });

  test('exact replay applies once; other commands, users, chats, messages and expiry are refused', async () => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha'); await fx.press('Delete place');
    const view = fx.last();
    const key = fx.find('Confirm', view).slice(3);
    const base = { ...fx.origin(), messageId: view.messageId, key };
    await rejected(fx.places.callback({ ...base, commandId: 'w1', actorId: 9 }));
    await rejected(fx.places.callback({ ...base, commandId: 'w2', target: { chatId: 3 } }));
    await rejected(fx.places.callback({ ...base, commandId: 'w3', messageId: view.messageId + 1 }));
    await rejected(fx.places.callback({ ...base, commandId: 'w4', principal: 'other' as never }));
    expect(await rankingNames()).toContain('Alpha');
    await openManage('Alpha'); await fx.press('Delete place');
    const second = fx.last();
    const request = { ...fx.origin(), messageId: second.messageId, key: fx.find('Confirm', second).slice(3) };
    const results = await Promise.allSettled([fx.places.callback(request), fx.places.callback(request)]);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    expect(fx.sent.filter(m => m.text.includes('Place deleted.'))).toHaveLength(1);
    expect(await fx.places.callback(request)).toEqual({ toast: 'Already applied' });
    expect(await rejected(fx.places.callback({ ...request, commandId: 'other' }))).toMatch(/already used/);
    // Expiry
    await addPlace('Beta', 'Pizza');
    await openManage('Beta'); await fx.press('Delete place');
    const third = fx.last();
    fx.control.time += 11 * 60_000;
    expect(await rejected(fx.press('Confirm', third))).toMatch(/expired/);
  });

  test('a pending confirmation survives restart; /new and invalidate void it', async () => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha'); await fx.press('Delete place');
    const view = fx.last();
    await fx.reopen();
    await fx.press('Confirm', view);
    expect(fx.last().text).toContain('Place deleted.');
    await addPlace('Beta', 'Pizza');
    await openManage('Beta'); await fx.press('Delete place');
    const second = fx.last();
    await fx.places.invalidate();
    expect(await rejected(fx.press('Confirm', second))).toMatch(/expired/);
    await openManage('Beta'); await fx.press('Delete place');
    const third = fx.last();
    await fx.root.commit(async tx => { (await tx.doc(Bindings, fx.root.id)).epoch = 2; }, context);
    expect(await rejected(fx.press('Confirm', third))).toMatch(/expired/);
    await fx.root.commit(async tx => { const b = await tx.doc(Bindings, fx.root.id); b.epoch = 1; }, context);
    expect(await rankingNames()).toContain('Beta');
  });

  test('a killed confirmation is never repeated; redelivery says it was interrupted', async () => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha'); await fx.press('Delete place');
    const view = fx.last();
    const request = { ...fx.origin(), messageId: view.messageId, key: fx.find('Confirm', view).slice(3) };
    const base = fx.control.commits;
    fx.control.failCommit = n => n === base + 2 ? 'after' : undefined;
    await expect(fx.places.callback(request)).rejects.toThrow('crash after effect');
    fx.control.failCommit = undefined;
    await fx.reopen();
    await expect(fx.places.callback(request)).resolves.toEqual({});
    expect(fx.last().text).toContain('may or may not have been applied');
    expect(await rankingNames()).toContain('No places ranked yet.');
  });

  test('a failed result presentation is re-presented on redelivery without a second effect', async () => {
    await addPlace('Alpha', 'Pizza');
    await openManage('Alpha'); await fx.press('Delete place');
    const view = fx.last();
    const request = { ...fx.origin(), messageId: view.messageId, key: fx.find('Confirm', view).slice(3) };
    fx.control.failNextPresent = true;
    expect(await fx.places.callback(request)).toEqual({ toast: 'Could not send the next step. Open /place_rankings.' });
    await fx.places.callback(request);
    expect(fx.last().text).toContain('Place deleted.');
    expect(await rankingNames()).toContain('No places ranked yet.');
  });
});

describe('model path', () => {
  test('legacy places keeps version 1 and refuses confirmation through its bundle', async () => {
    const legacy = createNativePlaces({ config: { ...fx.config, capabilityProfile: 'durable-places-test' }, host: () => fx.host, present: async () => ({ messageId: 1 }) });
    try {
      const bundle = legacy.bundle();
      expect(bundle.version).toBe(1);
      expect(bundle.tools[0]!.version).toBe(1);
      const registration = bundle.tools[0]!.tool as unknown as { execute(args: unknown, api: unknown, ctx: unknown): Promise<{ output: Array<{ text: string }> }> };
      const result = await registration.execute({ action: 'request_confirmation', confirmation_operation: 'delete_place', place_id: 'synthetic' }, fx.api, context);
      expect(JSON.parse(result.output[0]!.text)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    } finally { await legacy.close(); }
  });
  test('request_confirmation shows direct buttons, returns no token and ends the round', async () => {
    await addPlace('Alpha', 'Pizza');
    await fx.places.command(fx.origin()); await fx.press('View rankings'); await fx.press('Pizza (1)');
    const placeId = Object.values((await fx.state()).actions).find(a => (a as never as { args: { placeId?: string } }).args.placeId)!;
    const id = (placeId as never as { args: { placeId: string } }).args.placeId;
    const result = await tool({ action: 'request_confirmation', confirmation_operation: 'delete_place', place_id: id });
    expect(result).toMatchObject({ ok: true, terminate: true, result: { kind: 'confirmation_requested', operation: 'delete_place' } });
    expect(result.raw).not.toMatch(/token|pp:/);
    expect(fx.labels()).toEqual(['Confirm', 'Cancel']);
    expect(fx.last().text).toContain('Delete Alpha?');
    expect(await rankingNames()).toContain('Alpha');
    await openManage('Alpha'); // Model refusal with a leaked capability key is still refused.
    const key = fx.find('Delete place').slice(3);
    expect(await tool({ action: 'delete_place', place_id: id, confirmation_token: key, confirmation_operation: 'delete_place' }))
      .toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(await rankingNames()).toContain('Alpha');
  });

  test('the model prompt is confirmed by the user Confirm button', async () => {
    await addPlace('Alpha', 'Pizza');
    const before = fx.last();
    await fx.press('Undo addition', before);
    await fx.press('Cancel');
    const insertion = Object.values((await fx.state()).actions).map(a => (a as never as { args: { insertionId?: string } }).args.insertionId).find(Boolean)!;
    const result = await tool({ action: 'request_confirmation', confirmation_operation: 'undo_addition', insertion_id: insertion });
    expect(result.ok).toBe(true);
    await fx.press('Confirm');
    expect(fx.last().text).toContain('Addition undone.');
  });

  test('request_confirmation reports invalid or missing targets without a prompt', async () => {
    const count = fx.sent.length;
    expect(await tool({ action: 'request_confirmation' })).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } });
    expect(await tool({ action: 'request_confirmation', confirmation_operation: 'delete_place' })).toMatchObject({ ok: false });
    expect(await tool({ action: 'request_confirmation', confirmation_operation: 'delete_place', place_id: 'missing' })).toMatchObject({ ok: false });
    expect(fx.sent).toHaveLength(count);
  });

  test('a failed confirmation presentation cannot authorize anything', async () => {
    await addPlace('Alpha', 'Pizza');
    await fx.places.command(fx.origin());
    const before = new Set(Object.keys((await fx.state()).actions));
    await fx.press('View rankings'); await fx.press('Pizza (1)'); await fx.press('Alpha');
    const manage = fx.last();
    await fx.press('Manage', manage);
    const id = Object.values((await fx.state()).actions).map(a => (a as never as { args: { placeId?: string } }).args.placeId).find(Boolean)!;
    fx.control.failNextPresent = true;
    expect(await tool({ action: 'request_confirmation', confirmation_operation: 'delete_place', place_id: id }))
      .toMatchObject({ ok: false, error: { code: 'PRESENTATION_FAILED' } });
    const unsent = Object.values((await fx.state()).actions).filter(a => a.messageId === null && a.state === 'issued');
    expect(unsent.length).toBeGreaterThan(0);
    for (const record of unsent) await rejected(fx.places.callback({ ...fx.origin(), messageId: 101, key: record.key }));
    expect(before.size).toBeGreaterThan(0);
    expect(await rankingNames()).toContain('Alpha');
  });
});
