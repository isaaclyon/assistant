import { PlacesApplication } from '../../src/places-application.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import type { NativeConfig } from '../../src/durable/config.js';
import type { DurableHost } from '../../src/durable/host.js';
import { Bindings, context } from '../../src/durable/ingress.js';
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
  await root.commit(async tx => { const state = await tx.doc(Bindings, root.id); state.epoch = 1; state.epochs['1'] = root.id; }, context);
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
  return { ...JSON.parse(result.output[0]!.text), isError: result.isError, terminate: result.control?.terminate };
}
/** Adds a category and one ranked place through the direct buttons. */
async function addPlace(name: string, category: string, sentiment: 'Liked' | 'Alright' | 'Disliked' = 'Liked') {
  await fx.places.command(fx.origin());
  while (fx.last().text.includes('Which is better?')) await fx.press(fx.labels()[0]!);
  if (!fx.labels().includes('Add place')) await fx.places.command(fx.origin());
  await fx.press('Add place');
  expect(await fx.reply(name)).toBe(true);
  if (!fx.labels().includes(category)) {
    await fx.press('New category'); await fx.reply(category);
  }
  await fx.press(category);
  await fx.press(sentiment);
}

describe('direct menu and capabilities', () => {
  test('menu buttons bind to the acknowledged message and are one use', async () => {
    await fx.places.command(fx.origin());
    expect(fx.last().text).toContain('Place Rankings');
    expect(fx.labels()).toEqual(['Add place', 'View rankings', 'Manage places', 'New category', 'Manage categories']);
    for (const button of fx.last().buttons.flat()) expect(button.callback).toMatch(/^pp:[0-9a-f]{32}$/);
    const menu = fx.last();
    await fx.press('View rankings');
    expect(fx.last().text).toContain('Rankings');
    expect(await rejected(fx.press('View rankings', menu, {}))).toMatch(/already used/);
    // Wrong message and foreign actor are refused without effect.
    await fx.places.command(fx.origin());
    const second = fx.last();
    await rejected(fx.places.callback({ ...fx.origin(), messageId: 5, key: fx.find('Add place', second).slice(3) }));
    await rejected(fx.places.callback({ ...fx.origin(), actorId: 9, messageId: second.messageId, key: fx.find('Add place', second).slice(3) }));
    expect(fx.sent).toHaveLength(3);
  });

  test('no acknowledged message disables the buttons of a failed presentation', async () => {
    fx.control.failNextPresent = true;
    await expect(fx.places.command(fx.origin())).rejects.toThrow('telegram down');
    const state = await fx.state();
    const keys = Object.values(state.actions);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every(record => record.messageId === null)).toBe(true);
    await rejected(fx.places.callback({ ...fx.origin(), messageId: 101, key: keys[0]!.key }));
    await fx.places.command(fx.origin());
    expect(fx.labels()).toContain('Add place');
  });

  test('expired capabilities and a new epoch are refused', async () => {
    await fx.places.command(fx.origin());
    const menu = fx.last();
    await fx.root.commit(async tx => { (await tx.doc(Bindings, fx.root.id)).epoch = 2; }, context);
    expect(await rejected(fx.press('Add place', menu))).toMatch(/expired/);
    const expired = createNativePlaces({ config: fx.config, host: () => fx.host, present: async () => ({ messageId: 1 }), now: () => Date.now() + 11 * 60_000 });
    await expect(expired.command(fx.origin())).resolves.toEqual({});
    await expired.close();
  });

  test('a place-rankings command from another actor or thread is refused', async () => {
    await rejected(fx.places.command({ ...fx.origin(), actorId: 3 }));
    await rejected(fx.places.command({ ...fx.origin(), target: { chatId: 2, threadId: 4 } }));
    expect(fx.sent).toHaveLength(0);
  });
});

describe('add, compare and browse', () => {
  test('text name, category, sentiment, comparison, back and paginated ranking', async () => {
    await addPlace('Alpha', 'Pizza');
    expect(fx.last().text).toContain('Ranked Alpha');
    await addPlace('Beta', 'Pizza', 'Liked');
    expect(fx.last().text).toContain('Which is better?');
    expect(fx.labels()).toEqual(['Beta', 'Alpha', 'Cancel ranking']);
    await fx.press('Beta');
    expect(fx.last().text).toContain('Ranked Beta');
    expect(fx.last().text).toContain('#1 of 2');
    await fx.press('View ranking');
    expect(fx.last().text).toContain('1. Beta\n2. Alpha');
    await fx.press('Alpha');
    expect(fx.last().text).toContain('Rank: #2');
    expect(fx.labels()).toEqual(['Add/edit notes', 'Manage']);
    await fx.press('Add/edit notes');
    expect(fx.last().text).toContain('notes for this place');
    await fx.reply('Great crust');
    expect(fx.last().text).toContain('Notes: Great crust');
    await fx.press('Manage');
    expect(fx.labels()).toEqual(['Edit name', 'Edit notes', 'Clear notes', 'Move category', 'Re-rank', 'Delete place']);
    await fx.press('Clear notes');
    expect(fx.last().text).not.toContain('Notes:');
  });

  test('comparison Back returns to the earlier question and a second press of the old answer is stale', async () => {
    await addPlace('Alpha', 'Pizza');
    await addPlace('Beta', 'Pizza');
    await addPlace('Gamma', 'Pizza');
    // Gamma is compared with the middle existing place; answer once and go back.
    const first = fx.last();
    await fx.press(first.buttons[0]![0]!.text);
    const second = fx.last();
    expect(second.text).toMatch(/Which is better|Ranked/);
    if (second.text.includes('Which is better')) {
      await fx.press('Back');
      expect(fx.last().text).toContain('Which is better?');
    }
    await rejected(fx.press(first.buttons[0]![0]!.text, first));
  });

  test('resume shows an unfinished comparison and the menu has no destructive buttons', async () => {
    await addPlace('Alpha', 'Pizza');
    await addPlace('Beta', 'Pizza');
    await fx.places.command(fx.origin());
    expect(fx.last().text).toContain('Which is better?');
    expect(fx.labels(fx.sent[0]!)).not.toEqual(expect.arrayContaining(['Delete place']));
    expect(fx.labels()).toContain('Cancel ranking');
  });

  test('duplicate names and failed domain effects show a notice and the recovery view', async () => {
    await addPlace('Alpha', 'Pizza');
    await fx.press('View ranking');
    await fx.places.command(fx.origin());
    await fx.press('Add place');
    await fx.reply('Alpha');
    await fx.press('Pizza');
    await fx.press('Liked');
    expect(fx.last().text).toContain('already exists');
    expect(fx.labels()).toEqual(['Liked', 'Alright', 'Disliked']);
    await fx.press('Alright');
    expect(fx.last().text).toContain('already exists');
  });

  test('more than one page of places paginates', async () => {
    await addPlace('P0', 'Many');
    for (let i = 1; i < 9; i++) {
      await fx.places.command(fx.origin());
      if (fx.last().text.includes('Which is better')) { for (let n = 0; n < 6 && fx.last().text.includes('Which is better'); n++) await fx.press(fx.labels()[0]!); }
      await fx.press('Add place'); await fx.reply(`P${i}`); await fx.press('Many'); await fx.press('Liked');
      for (let n = 0; n < 8 && fx.last().text.includes('Which is better'); n++) await fx.press(fx.labels()[0]!);
    }
    await fx.places.command(fx.origin());
    await fx.press('View rankings');
    await fx.press('Many (9)');
    expect(fx.labels()).toContain('Next');
    await fx.press('Next');
    expect(fx.labels()).toContain('Previous');
  });
});

describe('text input', () => {
  test('only an exact reply to the current prompt is consumed', async () => {
    await fx.places.command(fx.origin());
    const menu = fx.last();
    expect(await fx.reply('hello', menu)).toBe(false);
    await fx.press('Add place');
    const prompt = fx.last();
    expect(await fx.reply('hello', { ...prompt, messageId: prompt.messageId + 50 })).toBe(false);
    expect(await fx.reply('hello', prompt, { actorId: 9 })).toBe(false);
    expect(await fx.reply('hello', prompt, { principal: 'emma' })).toBe(false);
    expect((await fx.state()).draft).toBeNull();
    expect(await fx.reply('Hello Cafe', prompt)).toBe(true);
    expect((await fx.state()).draft?.name).toBe('Hello Cafe');
  });

  test('a redelivered reply does not repeat its domain effect or duplicate a presented answer', async () => {
    await fx.places.command(fx.origin());
    await fx.press('New category');
    const prompt = fx.last();
    const request = { ...fx.origin(), messageId: 777, replyToMessageId: prompt.messageId, text: 'Tacos' };
    expect(await fx.places.input(request)).toBe(true);
    const count = fx.sent.length;
    expect(await fx.places.input(request)).toBe(true);
    expect(fx.sent).toHaveLength(count);
    // A different update to the consumed prompt is acknowledged and never forwarded to the model.
    expect(await fx.places.input({ ...request, commandId: 'other' })).toBe(true);
    expect(fx.last().text).toContain('already received');
    await fx.places.command(fx.origin());
    await fx.press('View rankings');
    expect(fx.labels()).toContain('Tacos (0)');
  });

  test('a superseded or cancelled prompt consumes its stale reply instead of sending it to the model', async () => {
    await fx.places.command(fx.origin());
    await fx.press('Add place');
    const first = fx.last();
    await fx.places.command(fx.origin());
    expect(await fx.reply('late name', first)).toBe(true);
    expect(fx.last().text).toContain('no longer active');
    expect((await fx.state()).draft).toBeNull();
    await fx.places.command(fx.origin());
    await fx.press('Add place');
    const second = fx.last();
    await fx.press('Cancel input');
    expect(await fx.reply('also late', second)).toBe(true);
    expect((await fx.state()).draft).toBeNull();
  });

  test('a new epoch cancels the prompt and an expired prompt is consumed', async () => {
    await fx.places.command(fx.origin());
    await fx.press('Add place');
    const prompt = fx.last();
    await fx.root.commit(async tx => { (await tx.doc(Bindings, fx.root.id)).epoch = 2; }, context);
    expect(await fx.reply('name', prompt)).toBe(true);
    expect((await fx.state()).draft).toBeNull();
  });

  test('presentation failure after a consumed reply is not propagated to the model path', async () => {
    await fx.places.command(fx.origin());
    await fx.press('Add place');
    const prompt = fx.last();
    fx.control.failNextPresent = true;
    expect(await fx.reply('Name', prompt)).toBe(true);
    expect((await fx.state()).draft?.name).toBe('Name');
    // The failed message's buttons are unbound; /place_rankings reopens the saved step.
    await fx.places.command(fx.origin());
    expect(fx.last().text).toContain('Adding Name');
  });

  test('invalid names show a notice', async () => {
    await fx.places.command(fx.origin());
    await fx.press('Add place');
    expect(await fx.reply('   ')).toBe(true);
    expect(fx.last().text).toContain('between 1 and 200');
    expect(fx.labels()).toContain('Add place');
  });
});

describe('draft survival and invalidation', () => {
  test('/new keeps the add draft, voids old buttons, and the command reopens the step', async () => {
    await fx.places.command(fx.origin());
    await fx.press('Add place');
    await fx.reply('Keeper');
    const picker = fx.last();
    await fx.press('New category'); await fx.reply('Soup');
    const afterCategory = fx.last();
    await fx.root.commit(async tx => { (await tx.doc(Bindings, fx.root.id)).epoch = 2; }, context);
    await rejected(fx.press('Soup', afterCategory));
    await rejected(fx.press('Coffee', picker));
    await fx.places.command(fx.origin());
    expect(fx.last().text).toContain('Adding Keeper');
    await fx.press('Soup');
    expect(fx.last().text).toContain('What was your overall impression?');
  });

  test('a changed draft voids older category buttons (draft generation)', async () => {
    await fx.places.command(fx.origin());
    await fx.press('New category'); await fx.reply('Soup');
    await fx.places.command(fx.origin());
    await fx.press('Add place'); await fx.reply('One');
    const picker = fx.last();
    await tool({ action: 'categories', name: 'Two' });
    expect(await rejected(fx.press('Soup', picker))).toMatch(/expired/);
  });

  test('invalidate expires buttons and prompts but keeps the draft', async () => {
    await tool({ action: 'categories', name: 'Draft Name' });
    const picker = fx.last();
    await fx.press('New category');
    const prompt = fx.last();
    await fx.places.invalidate();
    await rejected(fx.press('Coffee', picker));
    expect(await fx.reply('x', prompt)).toBe(true);
    expect((await fx.state()).draft?.name).toBe('Draft Name');
    await fx.places.command(fx.origin());
    expect(fx.last().text).toContain('Adding Draft Name');
  });

  test('invalidate keeps an unfinished comparison', async () => {
    await addPlace('Alpha', 'Pizza');
    await addPlace('Beta', 'Pizza');
    const compare = fx.last();
    expect(compare.text).toContain('Which is better?');
    await fx.places.invalidate();
    await rejected(fx.press(compare.buttons[0]![0]!.text, compare));
    await fx.places.command(fx.origin());
    expect(fx.last().text).toContain('Which is better?');
  });
});

describe('crash recovery', () => {
  test('killed after claim before the effect: redelivery is interrupted and not repeated', async () => {
    await fx.places.command(fx.origin());
    await fx.press('New category');
    const prompt = fx.last();
    // Commits: claim (n+1), effect (n+2). Fail the effect before it runs.
    const base = fx.control.commits;
    fx.control.failCommit = n => n === base + 2 ? 'before' : undefined;
    const request = { ...fx.origin(), messageId: 800, replyToMessageId: prompt.messageId, text: 'Ramen' };
    await expect(fx.places.input(request)).rejects.toThrow('crash before');
    fx.control.failCommit = undefined;
    await fx.reopen();
    expect(await fx.places.input(request)).toBe(true);
    expect(fx.last().text).toContain('interrupted');
    await fx.places.command(fx.origin());
    await fx.press('View rankings');
    expect(fx.labels()).not.toContain('Ramen (0)');
  });

  test('killed after the effect before its result was stored: redelivery shows interrupted and never repeats it', async () => {
    await fx.places.command(fx.origin());
    await fx.press('New category');
    const prompt = fx.last();
    const base = fx.control.commits;
    fx.control.failCommit = n => n === base + 2 ? 'after' : undefined;
    const request = { ...fx.origin(), messageId: 801, replyToMessageId: prompt.messageId, text: 'Ramen' };
    await expect(fx.places.input(request)).rejects.toThrow('crash after effect');
    fx.control.failCommit = undefined;
    await fx.reopen();
    expect(await fx.places.input(request)).toBe(true);
    expect(fx.last().text).toContain('interrupted');
    expect(fx.last().text).toContain('may or may not have been applied');
    expect(fx.labels()).toContain('View rankings');
    expect(await fx.places.input(request)).toBe(true);
    await fx.places.command(fx.origin());
    await fx.press('View rankings');
    // The effect happened exactly once.
    expect(fx.labels().filter(label => label === 'Ramen (0)')).toHaveLength(1);
  });

  test('a write button killed mid-effect is interrupted on redelivery, not executed twice', async () => {
    await addPlace('Alpha', 'Pizza');
    await addPlace('Beta', 'Pizza');
    const compare = fx.last();
    const callbackRequest = { ...fx.origin(), messageId: compare.messageId, key: fx.find('Beta', compare).slice(3) };
    const base = fx.control.commits;
    fx.control.failCommit = n => n === base + 2 ? 'after' : undefined;
    await expect(fx.places.callback(callbackRequest)).rejects.toThrow('crash after effect');
    fx.control.failCommit = undefined;
    await fx.reopen();
    await expect(fx.places.callback(callbackRequest)).resolves.toEqual({});
    expect(fx.last().text).toContain('interrupted');
    // Other update ids for the used key are still refused.
    expect(await rejected(fx.places.callback({ ...callbackRequest, commandId: 'later' }))).toMatch(/already used/);
  });

  test('a completed callback redelivered after the result message was acknowledged only toasts', async () => {
    await fx.places.command(fx.origin());
    const menu = fx.last();
    const request = { ...fx.origin(), messageId: menu.messageId, key: fx.find('View rankings', menu).slice(3) };
    await fx.places.callback(request);
    const count = fx.sent.length;
    await expect(fx.places.callback(request)).resolves.toEqual({ toast: 'Already applied' });
    expect(fx.sent).toHaveLength(count);
  });

  test('a callback whose result presentation failed is re-presented on redelivery', async () => {
    await fx.places.command(fx.origin());
    const menu = fx.last();
    const request = { ...fx.origin(), messageId: menu.messageId, key: fx.find('View rankings', menu).slice(3) };
    fx.control.failNextPresent = true;
    await expect(fx.places.callback(request)).resolves.toMatchObject({ toast: expect.stringContaining('Could not send') });
    expect(fx.sent).toHaveLength(1);
    await expect(fx.places.callback(request)).resolves.toEqual({});
    expect(fx.last().text).toContain('Rankings');
  });
});

describe('rank_places tool', () => {
  test('uses a flat closed object schema, unsafe replay and the places bundle name', () => {
    const bundle = fx.places.bundle();
    const registration = bundle.tools[0]!.tool as unknown as { name: string; replay: string; parameters: { type: string; additionalProperties: boolean; anyOf?: unknown } };
    expect(bundle.name).toBe('places');
    expect(registration.name).toBe('rank_places');
    expect(registration.replay).toBe('unsafe');
    expect(registration.parameters.type).toBe('object');
    expect(registration.parameters.additionalProperties).toBe(false);
    expect(registration.parameters.anyOf).toBeUndefined();
  });

  test('direct destructive model actions are refused without effect or message', async () => {
    const before = fx.control.commits;
    for (const args of [
      { action: 'delete_place', place_id: 'x', confirmation_token: 't' }, { action: 'delete_category', category_id: 'x' },
      { action: 'undo_addition', insertion_id: 'x' }, { action: 'cancel', insertion_id: 'x', revision: 0 },
    ]) {
      expect(await tool(args)).toMatchObject({ ok: false, isError: true, error: { code: 'CONFIRMATION_REQUIRED' } });
    }
    expect(fx.control.commits).toBe(before);
    expect(fx.sent).toHaveLength(0);
    expect(existsSync(join(fx.stateDir, 'places.db'))).toBe(false);
  });

  test('invalid flat arguments fail before any effect', async () => {
    for (const args of [{ action: 'bogus' }, { action: 'start', extra: 1 }, { action: 'ranking', limit: 500 }, { action: 'create_category', name: '' }, {}]) {
      expect(await tool(args)).toMatchObject({ ok: false, isError: true, error: { code: 'INVALID_ACTION' } });
    }
    expect(existsSync(join(fx.stateDir, 'places.db'))).toBe(false);
  });

  test('categories with a name persists the draft and presents the picker; start presents the comparison', async () => {
    expect(await tool({ action: 'create_category', name: 'Tapas' })).toMatchObject({ ok: true });
    const categories = (await tool({ action: 'categories' })).result.categories as Array<{ id: string; name: string }>;
    const bars = categories.find(category => category.name === 'Bars')!.id;
    const picked = await tool({ action: 'categories', name: 'Tiki' });
    expect(picked).toMatchObject({ ok: true, presented: true, terminate: true });
    expect(fx.last().text).toContain('Adding Tiki');
    expect((await fx.state()).draft).toMatchObject({ name: 'Tiki', categoryId: null });
    await fx.press('Bars');
    await fx.press('Liked');
    expect(fx.last().text).toContain('Ranked Tiki');
    expect((await fx.state()).draft).toBeNull();
    const second = await tool({ action: 'start', name: 'Zed', category_id: bars, sentiment: 'liked' });
    expect(second).toMatchObject({ ok: true, presented: true });
    expect(fx.last().text).toContain('Which is better?');
    expect(await tool({ action: 'start', name: 'Other', category_id: bars, sentiment: 'liked' })).toMatchObject({ ok: false, error: { code: 'ACTIVE_INSERTION_EXISTS' } });
    const stale = await tool({ action: 'answer', insertion_id: 'old', revision: 3, existing_place_id: 'x', winner: 'candidate' });
    expect(stale).toMatchObject({ ok: true, result: { kind: 'stale' } });
    expect(await tool({ action: 'ranking', category_id: bars })).toMatchObject({ ok: true, presented: false, result: { total: 1 } });
  });

  test('the tool is refused in a stale conversation epoch', async () => {
    await fx.root.commit(async tx => { (await tx.doc(Bindings, fx.root.id)).epoch = 3; }, context);
    expect(await tool({ action: 'menu' })).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });

  test('a tool presentation failure leaves the capabilities disabled and tells the model', async () => {
    fx.control.failNextPresent = true;
    const result = await tool({ action: 'menu' });
    expect(result).toMatchObject({ ok: true, presented: false });
    expect(result.terminate).toBeFalsy();
    expect(Object.values((await fx.state()).actions).every(record => record.messageId === null)).toBe(true);
  });
});

describe('lifecycle', () => {
  test('the database opens only after the host exists and close is idempotent', async () => {
    fx.control.hostReady = false;
    await expect(fx.places.command(fx.origin())).rejects.toThrow('no host');
    expect(existsSync(join(fx.stateDir, 'places.db'))).toBe(false);
    fx.control.hostReady = true;
    await fx.places.command(fx.origin());
    expect(existsSync(join(fx.stateDir, 'places.db'))).toBe(true);
    await fx.places.close();
    await fx.places.close();
    await expect(fx.places.command(fx.origin())).rejects.toThrow('closed');
  });

  test('only the isaac principal can build the bundle', async () => {
    const other = await setup({ principal: 'emma' });
    expect(() => other.places.bundle()).toThrow(/isaac/);
    await other.cleanup();
  });

  test('capability and prompt records stay bounded', async () => {
    for (let i = 0; i < 40; i++) await fx.places.command(fx.origin());
    const state = await fx.state();
    expect(Object.values(state.actions).filter(record => record.state === 'issued').length).toBeLessThanOrEqual(128 + 6);
    expect(Object.keys(state.prompts).length).toBeLessThanOrEqual(64);
  });
});

describe('review regressions', () => {
  test('same callback update cannot replay an old-epoch view', async () => {
    await fx.places.command(fx.origin()); const view=fx.last(); const request={...fx.origin(),messageId:view.messageId,key:fx.find('Add place',view).slice(3)};
    await fx.places.callback(request);const count=fx.sent.length;
    await fx.root.commit(async tx=>{(await tx.doc(Bindings,fx.root.id)).epoch++;},context);
    await rejected(fx.places.callback(request));expect(fx.sent).toHaveLength(count);
  });

  test('pruned prompt bindings still consume delayed names', async () => {
    await fx.places.command(fx.origin());await fx.press('Add place');const prompt=fx.last();
    await fx.root.commit(async tx=>{(await tx.doc(PlacesNative,fx.root.id)).prompts={};},context);
    expect(await fx.reply('Private delayed name',prompt)).toBe(true);expect(fx.last().text).toContain('no longer active');
    expect((await fx.state()).draft).toBeNull();
  });

  test('an unacknowledged bot prompt quote is consumed without applying the input', async () => {
    await fx.places.command(fx.origin());fx.control.failReceipt=true;await fx.press('Add place');fx.control.failReceipt=false;
    const prompt=fx.last();expect(prompt.text).toMatch(/Input reference: [0-9a-f]{32}$/);
    const request={...fx.origin(),messageId:9000,replyToMessageId:prompt.messageId,text:'Private unbound name'};
    expect(await fx.places.input(request)).toBe(false);
    expect(await fx.places.input({...request,trustedPromptText:prompt.text})).toBe(true);
    expect((await fx.state()).draft).toBeNull();expect(fx.last().text).toContain('no longer active');
  });

  test('input requires a newer message and concurrent exact redelivery applies once', async () => {
    await fx.places.command(fx.origin());await fx.press('New category');const prompt=fx.last();
    const request={...fx.origin(),messageId:9000,replyToMessageId:prompt.messageId,text:'Concurrent Category'};
    expect(await fx.places.input({...request,messageId:prompt.messageId})).toBe(true);
    const execute=vi.spyOn(PlacesApplication.prototype,'execute');
    try {await Promise.all([fx.places.input(request),fx.places.input(request)]);expect(execute.mock.calls.filter(([params])=>params.action==='create_category')).toHaveLength(1);}finally{execute.mockRestore();}
  });

  test('close drains queued claims and all callers await the same cleanup', async () => {
    const gate=Promise.withResolvers<void>();fx.control.commitGate=gate.promise;
    const command=fx.places.command(fx.origin());let first=false,second=false;
    const close1=fx.places.close().then(()=>{first=true;}),close2=fx.places.close().then(()=>{second=true;});
    await Promise.resolve();expect(first).toBe(false);expect(second).toBe(false);
    gate.resolve();await command;await Promise.all([close1,close2]);expect(first&&second).toBe(true);
    await expect(fx.places.command(fx.origin())).rejects.toThrow('closed');
  });

  test('summary, move and draft categories expose all pages with bounded buttons', async () => {
    for(let i=0;i<18;i++)await tool({action:'create_category',name:`Category ${String(i).padStart(2,'0')}`});
    await fx.places.command(fx.origin());await fx.press('View rankings');expect(fx.last().buttons.length).toBeLessThanOrEqual(12);
    await fx.press('Next');await fx.press('Next');expect(fx.labels()).toContain('Previous');expect(fx.labels()).toContain('Menu');
    await tool({action:'categories',name:'Paged Draft'});const first=fx.last();await fx.press('Next');expect(fx.last().text).toContain('Paged Draft');
    const state=await fx.state();const key=fx.find('Next',first).slice(3);expect(state.actions[key].draftGen).not.toBeNull();
    await fx.press('Next');expect(fx.labels()).toContain('Category 17');await fx.press('Category 17');await fx.press('Liked');
    await fx.press('Add notes');await fx.reply('Notes');await fx.press('Manage');await fx.press('Move category');
    expect(fx.last().buttons.length).toBeLessThanOrEqual(12);await fx.press('Next');await fx.press('Next');expect(fx.labels()).toContain('Category 17');expect(fx.labels()).toContain('Previous');
  });
});


test('a prompt expiring between claim and effect gives a visible notice without a write', async () => {
  await fx.places.command(fx.origin()); await fx.press('New category'); const prompt = fx.last();
  const before = fx.control.commits;
  fx.control.failCommit = n => { if (n === before + 2) fx.control.time += 11 * 60_000; return undefined; };
  const execute = vi.spyOn(PlacesApplication.prototype, 'execute');
  try { expect(await fx.reply('Expired Category', prompt)).toBe(true); expect(execute.mock.calls.filter(([params]) => params.action === 'create_category')).toHaveLength(0); }
  finally { execute.mockRestore(); }
  expect(fx.last().text).toContain('no longer active');
});
