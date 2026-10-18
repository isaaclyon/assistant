import { randomUUID } from 'node:crypto';
import { profilePolicy } from './profiles.js';
import { join } from 'node:path';
import { StringEnum, Type, validateToolArguments } from '@earendil-works/pi-ai';
import { defineDoc, defineTool, type ConversationId, type Tx } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { PlacesApplication, type ConfirmationOperation, type PlacesCommand, type PreparedConfirmation } from '../places-application.js';
import { PlacesService, PlacesServiceError } from '../places-service.js';
import { normalizePlaceName, openPlacesStore, type PlacesStore } from '../places-store.js';
import type { NativeConfig } from './config.js';
import type { DurableHost } from './host.js';
import { Bindings, context, type Target } from './ingress.js';
import { textToolResult, type NativeBundle } from './registry.js';
import { UiRejectedError, type UiOrigin, type UiResult } from './telegram-bridge.js';
import { clean, type Buttons, type Presentation } from './telegram-ui.js';

/** Capability and prompt lifetime. */
export const PLACES_TTL_MS = 10 * 60_000;
const RETAIN_MS = 60 * 60_000;
const MAX_PENDING_ACTIONS = 128;
const MAX_ACTIONS = 512;
const MAX_PROMPTS = 64;
const PAGE = 8;

type Scalar = string | number | null;
type Args = { [key: string]: Scalar };
type Delivery = { text: string; buttons: Array<Array<{ text: string; callback: string }>>; keys: string[]; promptId: string | null; presented: boolean };
type ActionRecord = {
  key: string; op: string; args: Args; principal: string; actorId: number; chatId: number; epoch: string; draftGen: number | null;
  createdAt: number; expiresAt: number;
  /** Set only after Telegram acknowledges the message that carries this button. */
  messageId: number | null;
  state: 'issued' | 'claimed' | 'done' | 'expired';
  commandId: string | null;
  delivery: Delivery | null;
};
type PromptRecord = {
  id: string; kind: string; targetId: string | null; principal: string; actorId: number; chatId: number; epoch: string; draftGen: number | null;
  createdAt: number; expiresAt: number; messageId: number | null;
  state: 'pending' | 'consumed' | 'cancelled';
  commandId: string | null;
  delivery: Delivery | null;
};
type Draft = { name: string; categoryId: string | null; gen: number };
export type PlacesNativeState = {
  version: 1; draftGen: number; draft: Draft | null;
  actions: Record<string, ActionRecord>; prompts: Record<string, PromptRecord>;
  /** Compact message IDs prevent delayed prompt replies from entering model history after pruning. */
  promptMessages: Record<string, true>;
};
/** Persisted capabilities, the pre-add draft, the pending text prompt and one-use claim records. */
export const PlacesNative = defineDoc<PlacesNativeState>({
  kind: 'assistant.places-native', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ version: 1, draftGen: 0, draft: null, actions: {}, prompts: {}, promptMessages: {} }),
});

export interface NativePlacesOptions {
  config: NativeConfig;
  /** Throws until the durable host exists. The domain database opens only after this succeeds. */
  host: () => DurableHost;
  present: (target: Target, presentation: Presentation) => Promise<{ messageId: number }>;
  now?: () => number;
  randomKey?: () => string;
}
export type PlacesCallbackRequest = UiOrigin & { messageId: number; key: string };
export type PlacesInputRequest = UiOrigin & { messageId: number; replyToMessageId: number; text: string; trustedPromptText?: string };

const READ_OPS = new Set(['menu', 'categories', 'cancelInput', 'summaries', 'rank', 'place', 'manage', 'move', 'rerank', 'manageCategories', 'manageCategory', 'resume', 'ask', 'confirmAsk', 'confirmCancel']);
const PROMPT_KINDS: Record<string, string> = {
  add: 'the place name', newCategory: 'the new category name', renameCategory: 'the new category name',
  notes: 'the notes for this place', renamePlace: 'the new place name',
};
const SENTIMENTS = ['liked', 'alright', 'disliked'] as const;
type Sentiment = (typeof SENTIMENTS)[number];

// ---- Tool schema -----------------------------------------------------------
const ACTIONS = ['menu', 'categories', 'category_summaries', 'create_category', 'rename_category', 'delete_category', 'start', 'place', 'edit_place', 'delete_place', 'reposition', 'undo_addition', 'request_confirmation', 'resume', 'answer', 'back', 'cancel', 'ranking'] as const;
/** The model can only ask for a confirmation prompt; the user's Confirm button is the only approval. */
const DESTRUCTIVE_ACTIONS = new Set<string>(['delete_category', 'delete_place', 'undo_addition', 'cancel']);
const OPERATIONS = ['cancel', 'delete_place', 'delete_category', 'undo_addition'] as const;
export const placesToolParameters = Type.Object({
  action: StringEnum(ACTIONS),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  category_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  place_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  sentiment: Type.Optional(StringEnum(SENTIMENTS)),
  notes: Type.Optional(Type.String({ maxLength: 4_000 })),
  insertion_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  revision: Type.Optional(Type.Integer({ minimum: 0 })),
  existing_place_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  winner: Type.Optional(StringEnum(['candidate', 'existing'] as const)),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  confirmation_operation: Type.Optional(StringEnum(['cancel', 'delete_place', 'delete_category', 'undo_addition'] as const)),
  confirmation_token: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });
export const PLACES_TOOL_DESCRIPTION = "Maintain the user's private restaurant, coffee-shop, bar, and other place rankings. Supports categories, adding a place, durable pairwise comparisons, resume, and paginated rankings. Deleting a place or category, undoing an addition and cancelling a ranking happen only after the user presses Confirm in Telegram. Use request_confirmation to show that prompt; it returns no approval token.";
export const PLACES_TOOL_GUIDELINES = [
  'Use rank_places whenever the user asks to add, rank, compare, resume, or list restaurants, coffee shops, bars, or other saved places.',
  'When adding a place, collect its name, then call rank_places with action categories and that name; Telegram then shows direct category, sentiment and comparison buttons to the user. Do not repeat or invent those buttons.',
  'To delete a place or category, undo an addition or cancel a ranking, call request_confirmation with confirmation_operation and the target. Telegram then shows the user direct Confirm and Cancel buttons. Never call delete_place, delete_category, undo_addition or cancel yourself, never ask for or invent a confirmation token, and do not repeat the buttons.',
];

const escapeError = (error: unknown): string => error instanceof PlacesServiceError ? error.message : 'Unable to finish that action. Open /place_rankings to inspect the current state.';

export function createNativePlaces(options: NativePlacesOptions) {
  const { config } = options;
  const mutationsEnabled = profilePolicy(config.capabilityProfile)?.mutations === true;
  const description = mutationsEnabled ? PLACES_TOOL_DESCRIPTION : "Maintain the user's private restaurant, coffee-shop, bar, and other place rankings. Supports categories, adding a place, durable pairwise comparisons, resume, and paginated rankings. Deleting, undoing, cancelling and confirmation requests are unavailable in this migration slice.";
  const now = options.now ?? Date.now;
  const randomKey = options.randomKey ?? (() => randomUUID().replaceAll('-', ''));
  const allowed = config.transport.allowedUserId;
  const target: Target = { chatId: allowed };
  const ownerKey = `instance:${config.instanceId}:principal:${config.principal}`;
  let closed = false;
  let closing: Promise<void> | undefined;
  let domain: { store: PlacesStore; app: PlacesApplication } | undefined;
  const inflight = new Set<Promise<unknown>>();
  let lock: Promise<unknown> = Promise.resolve();
  const delivering = new Map<string, Promise<void>>();

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work)).catch(() => {});
    return work;
  };
  /** Serializes the claim/effect sections so interleaved updates cannot race on one ranking. */
  const locked = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lock.then(work);
    lock = result.catch(() => {});
    return result;
  };
  const assertOpen = () => { if (closed) throw new Error('Places is closed'); };
  const app = (): PlacesApplication => {
    assertOpen();
    options.host(); // The writer lease belongs to the host; open the database only after it exists.
    if (!domain) {
      const store = openPlacesStore(join(config.stateDir, 'places.db'));
      domain = { store, app: new PlacesApplication(new PlacesService(store, { ownerKey })) };
    }
    return domain.app;
  };
  const plain = <T,>(value: T): T => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
  const root = () => { const host = options.host(); return { host, id: host.runtime.root.id, commit: <T>(fn: (tx: Tx) => Promise<T>) => host.runtime.root.commit(async tx => plain(await fn(tx)), context) }; };

  async function authority(tx: Tx, conversationId?: ConversationId): Promise<{ epoch: string } | undefined> {
    const state = await tx.doc(Bindings, root().id);
    const epoch = String(state.epoch);
    const cid = state.epochs[epoch];
    if (conversationId !== undefined && cid !== conversationId) return undefined;
    const sources = Object.values(state.sources).filter(source => cid !== undefined && source.conversationId === cid && !source.cancelled);
    if (sources.some(source => source.principal !== config.principal || source.chatId !== allowed || source.threadId !== null)) return undefined;
    return { epoch };
  }
  const originOk = (request: UiOrigin) => request.actorId === allowed && request.principal === config.principal && request.target.chatId === allowed && request.target.threadId === undefined;

  // ---- State helpers --------------------------------------------------------
  type Ctx = { state: PlacesNativeState; epoch: string; keys: string[]; promptId: string | null };
  const issued = (state: PlacesNativeState) => Object.values(state.actions).filter(record => record.state === 'issued');
  function prune(state: PlacesNativeState): void {
    const time = now();
    for (const [key, record] of Object.entries(state.actions)) if (record.expiresAt + RETAIN_MS < time) delete state.actions[key];
    for (const [id, prompt] of Object.entries(state.prompts)) if (prompt.expiresAt + RETAIN_MS < time && prompt.state !== 'pending') delete state.prompts[id];
    const pending = issued(state).sort((a, b) => a.createdAt - b.createdAt);
    for (const record of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_ACTIONS))) delete state.actions[record.key];
    const all = Object.values(state.actions).sort((a, b) => a.createdAt - b.createdAt);
    for (const record of all.slice(0, Math.max(0, all.length - MAX_ACTIONS))) delete state.actions[record.key];
    const prompts = Object.values(state.prompts).sort((a, b) => a.createdAt - b.createdAt);
    for (const prompt of prompts.slice(0, Math.max(0, prompts.length - MAX_PROMPTS))) delete state.prompts[prompt.id];
  }
  const cancelPending = (state: PlacesNativeState) => { for (const prompt of Object.values(state.prompts)) if (prompt.state === 'pending') prompt.state = 'cancelled'; };
  function mint(ctx: Ctx, text: string, op: string, args: Args = {}, draftBound = false): { text: string; callback: string } {
    const key = randomKey();
    ctx.state.actions[key] = {
      key, op, args, principal: config.principal, actorId: allowed, chatId: allowed, epoch: ctx.epoch,
      draftGen: draftBound ? ctx.state.draft?.gen ?? -1 : null, createdAt: now(), expiresAt: now() + PLACES_TTL_MS,
      messageId: null, state: 'issued', commandId: null, delivery: null,
    };
    ctx.keys.push(key);
    return { text: clean(text, 64), callback: `pp:${key}` };
  }
  /** Preview with direct Confirm/Cancel buttons. The snapshot taken here is stored in the Confirm capability. */
  function confirmView(ctx: Ctx, prepared: PreparedConfirmation, label?: string): Presentation {
    const group = randomKey();
    const args: Args = { operation: prepared.operation, grp: group };
    if (prepared.insertionId !== undefined) args.insertionId = prepared.insertionId;
    if (prepared.revision !== undefined) args.revision = prepared.revision;
    if (prepared.placeId !== undefined) args.placeId = prepared.placeId;
    if (prepared.categoryId !== undefined) args.categoryId = prepared.categoryId;
    if (prepared.snapshot) { args.snapCategoryId = prepared.snapshot.categoryId; args.snapRevision = prepared.snapshot.revision; }
    const what = {
      cancel: 'Cancel this unfinished ranking? The place being added is not saved.',
      undo_addition: label ? `Undo adding ${label}? It is removed from your ranking.` : 'Undo this addition? The place is removed from your ranking.',
      delete_place: label ? `Delete ${label}? This cannot be undone.` : 'Delete this place? This cannot be undone.',
      delete_category: label ? `Delete the empty category ${label}? This cannot be undone.` : 'Delete this empty category? This cannot be undone.',
    }[prepared.operation];
    const confirm = mint(ctx, 'Confirm', 'confirm', args);
    const cancel = mint(ctx, 'Cancel', 'confirmCancel', { grp: group });
    return { text: `Confirm\n\n${what}\nThis request expires in 10 minutes.`, buttons: [[confirm, cancel]] };
  }
  const deliveryOf = (ctx: Ctx, view: Presentation): Delivery => ({ text: view.text, buttons: (view.buttons ?? []) as Delivery['buttons'], keys: ctx.keys, promptId: ctx.promptId, presented: false });

  // ---- Views ---------------------------------------------------------------
  type Category = { id: string; name: string };
  const menuView = (ctx: Ctx): Presentation => ({
    text: 'Place Rankings\n\nAdd a place or browse your rankings.',
    buttons: [
      [mint(ctx, 'Add place', 'ask', { kind: 'add' })],
      [mint(ctx, 'View rankings', 'summaries')],
      [mint(ctx, 'Manage places', 'summaries')],
      [mint(ctx, 'New category', 'ask', { kind: 'newCategory' })],
      [mint(ctx, 'Manage categories', 'manageCategories')],
    ],
  });
  function categoryPage(ctx: Ctx, service: PlacesApplication, text: string, offset: number, forDraft: boolean): Presentation {
    const categories = service.execute({ action: 'categories' }).categories as Category[];
    const at = Math.min(Math.floor(Math.max(0, offset) / PAGE) * PAGE, Math.floor(Math.max(0, categories.length - 1) / PAGE) * PAGE);
    const page = categories.slice(at, at + PAGE);
    const buttons: Buttons = page.map(category => [forDraft ? mint(ctx, category.name, 'draftCategory', { categoryId: category.id }, true) : mint(ctx, category.name, 'manageCategory', { categoryId: category.id })]);
    const nav: Array<{ text: string; callback: string }> = [];
    if (at > 0) nav.push(mint(ctx, 'Previous', 'categories', { offset: Math.max(0, at - PAGE), forDraft: forDraft ? 1 : 0 }, forDraft));
    if (at + PAGE < categories.length) nav.push(mint(ctx, 'Next', 'categories', { offset: at + PAGE, forDraft: forDraft ? 1 : 0 }, forDraft));
    if (nav.length) buttons.push(nav);
    buttons.push([mint(ctx, 'New category', 'ask', { kind: 'newCategory' })]);
    return { text: forDraft && ctx.state.draft ? `${text}\n\nAdding ${ctx.state.draft.name}.` : text, buttons };
  }
  const draftView = (ctx: Ctx, service: PlacesApplication): Presentation | undefined => {
    const draft = ctx.state.draft;
    if (!draft) return undefined;
    if (!draft.categoryId) {
      const view = categoryPage(ctx, service, 'Choose a category', 0, true);
      return view;
    }
    return {
      text: `What was your overall impression?\n\nAdding ${draft.name}.`,
      buttons: [[
        mint(ctx, 'Liked', 'draftSentiment', { sentiment: 'liked' }, true),
        mint(ctx, 'Alright', 'draftSentiment', { sentiment: 'alright' }, true),
        mint(ctx, 'Disliked', 'draftSentiment', { sentiment: 'disliked' }, true),
      ]],
    };
  };
  function resultView(ctx: Ctx, result: unknown): Presentation {
    const value = (result ?? {}) as Record<string, any>;
    if (value.kind === 'compare') {
      const buttons: Buttons = [[
        mint(ctx, value.candidate.name, 'answer', { insertionId: value.insertionId, revision: value.revision, existingPlaceId: value.existingPlace.id, winner: 'candidate' }),
        mint(ctx, value.existingPlace.name, 'answer', { insertionId: value.insertionId, revision: value.revision, existingPlaceId: value.existingPlace.id, winner: 'existing' }),
      ]];
      if (value.revision > 0) buttons.push([mint(ctx, 'Back', 'back', { insertionId: value.insertionId, revision: value.revision })]);
      if (mutationsEnabled) buttons.push([mint(ctx, 'Cancel ranking', 'confirmAsk', { operation: 'cancel', insertionId: value.insertionId, revision: value.revision })]);
      return { text: `Which is better?\n\n${value.candidate.name} or ${value.existingPlace.name}?`, buttons };
    }
    if (value.kind === 'complete') {
      return {
        text: `Ranked ${value.place.name}\n\n#${value.rank} of ${value.total} in ${value.category.name}.`,
        buttons: [
          [mint(ctx, 'Add notes', 'ask', { kind: 'notes', targetId: value.place.id })],
          [mint(ctx, 'View ranking', 'rank', { categoryId: value.category.id, offset: 0 })],
          [mint(ctx, 'Add another', 'ask', { kind: 'add' })],
          ...(mutationsEnabled && value.undoInsertionId ? [[mint(ctx, 'Undo addition', 'confirmAsk', { operation: 'undo_addition', insertionId: value.undoInsertionId, label: clean(value.place.name, 80) })]] : []),
        ],
      };
    }
    return menuView(ctx);
  }
  function homeView(ctx: Ctx, service: PlacesApplication): Presentation {
    try { return resultView(ctx, service.execute({ action: 'resume' })); }
    catch (error) { if (!(error instanceof PlacesServiceError) || error.code !== 'NO_ACTIVE_INSERTION') throw error; }
    return draftView(ctx, service) ?? menuView(ctx);
  }
  function summariesView(ctx: Ctx, service: PlacesApplication, offset = 0): Presentation {
    const categories = service.execute({ action: 'category_summaries' }).categories;
    const buttons: Buttons = categories.slice(offset, offset + PAGE).map(category => [mint(ctx, `${category.name} (${category.placeCount})`, 'rank', { categoryId: category.id, offset: 0 })]);
    const nav: Array<{ text: string; callback: string }> = [];
    if (offset > 0) nav.push(mint(ctx, 'Previous', 'summaries', { offset: Math.max(0, offset - PAGE) }));
    if (offset + PAGE < categories.length) nav.push(mint(ctx, 'Next', 'summaries', { offset: offset + PAGE }));
    if (nav.length) buttons.push(nav);
    buttons.push([mint(ctx, 'Menu', 'menu')]);
    return { text: 'Rankings\n\nChoose a category.', buttons };
  }
  function rankingView(ctx: Ctx, service: PlacesApplication, categoryId: string, offset: number): Presentation {
    const category = service.execute({ action: 'category_summaries' }).categories.find(entry => entry.id === categoryId);
    if (!category) throw new PlacesServiceError('NOT_FOUND', 'That category no longer exists.');
    const ranking = service.execute({ action: 'ranking', category_id: categoryId, offset, limit: PAGE });
    const lines = ranking.places.length === 0 ? ['No places ranked yet.'] : ranking.places.map((place, index) => `${offset + index + 1}. ${place.name}`);
    const buttons: Buttons = ranking.places.map(place => [mint(ctx, place.name, 'place', { placeId: place.id })]);
    const nav: Array<{ text: string; callback: string }> = [];
    if (offset > 0) nav.push(mint(ctx, 'Previous', 'rank', { categoryId, offset: Math.max(0, offset - PAGE) }));
    if (ranking.hasNext) nav.push(mint(ctx, 'Next', 'rank', { categoryId, offset: offset + PAGE }));
    if (nav.length) buttons.push(nav);
    buttons.push([mint(ctx, 'Menu', 'menu')]);
    return { text: `${category.name}\n\n${lines.join('\n')}`, buttons };
  }
  function placeView(ctx: Ctx, service: PlacesApplication, placeId: string): Presentation {
    const place = service.execute({ action: 'place', place_id: placeId }).place;
    return {
      text: [place.name, `Rank: #${place.position + 1}`, `Sentiment: ${place.sentiment}`, ...(place.notes ? [`Notes: ${place.notes}`] : [])].join('\n'),
      buttons: [[mint(ctx, 'Add/edit notes', 'ask', { kind: 'notes', targetId: place.id })], [mint(ctx, 'Manage', 'manage', { placeId: place.id })]],
    };
  }
  function manageView(ctx: Ctx, service: PlacesApplication, placeId: string): Presentation {
    const place = service.execute({ action: 'place', place_id: placeId }).place;
    return {
      text: `Manage ${place.name}`,
      buttons: [
        [mint(ctx, 'Edit name', 'ask', { kind: 'renamePlace', targetId: place.id })],
        [mint(ctx, 'Edit notes', 'ask', { kind: 'notes', targetId: place.id })],
        ...(place.notes ? [[mint(ctx, 'Clear notes', 'clearNotes', { placeId: place.id })]] : []),
        [mint(ctx, 'Move category', 'move', { placeId: place.id })],
        [mint(ctx, 'Re-rank', 'rerank', { placeId: place.id })],
        ...(mutationsEnabled ? [[mint(ctx, 'Delete place', 'confirmAsk', { operation: 'delete_place', placeId: place.id, label: clean(place.name, 80) })]] : []),
      ],
    };
  }

  // ---- Effects ---------------------------------------------------------------
  type Outcome = { notice?: string; view: Presentation };
  const withNotice = (notice: string | undefined, view: Presentation): Presentation => notice ? { ...view, text: clean(`${notice}\n\n${view.text}`) } : view;
  const promptText = (kind: string, id: string) => `Reply to this message with ${PROMPT_KINDS[kind]}. This input expires in 10 minutes.\n\nInput reference: ${id}`;
  const isOwnPrompt = (text: string | undefined) => {
    const id = text?.match(/\n\nInput reference: ([0-9a-f]{32})$/)?.[1];
    return !!id && Object.keys(PROMPT_KINDS).some(kind => text === promptText(kind, id));
  };
  function ask(ctx: Ctx, service: PlacesApplication, kind: string, targetId: string | null): Presentation {
    if (!PROMPT_KINDS[kind]) throw new PlacesServiceError('INVALID_ACTION', 'Unknown input request.');
    if (targetId && (kind === 'notes' || kind === 'renamePlace')) service.execute({ action: 'place', place_id: targetId });
    if (targetId && kind === 'renameCategory') { if (!(service.execute({ action: 'categories' }).categories as Category[]).some(entry => entry.id === targetId)) throw new PlacesServiceError('NOT_FOUND', 'That category no longer exists.'); }
    if (kind === 'add') { ctx.state.draft = null; }
    cancelPending(ctx.state);
    const id = randomKey();
    ctx.state.prompts[id] = {
      id, kind, targetId, principal: config.principal, actorId: allowed, chatId: allowed, epoch: ctx.epoch,
      draftGen: kind === 'add' ? null : ctx.state.draft?.gen ?? null, createdAt: now(), expiresAt: now() + PLACES_TTL_MS, messageId: null,
      state: 'pending', commandId: null, delivery: null,
    };
    ctx.promptId = id;
    return {
      text: promptText(kind, id),
      buttons: [[mint(ctx, 'Cancel input', 'cancelInput')]],
    };
  }
  function runAction(ctx: Ctx, service: PlacesApplication, op: string, args: Args): Outcome {
    cancelPending(ctx.state);
    const text = (name: string) => String(args[name] ?? '');
    switch (op) {
      case 'menu': case 'cancelInput': case 'resume': return { view: homeView(ctx, service) };
      case 'summaries': return { view: summariesView(ctx, service, Number(args.offset ?? 0)) };
      case 'categories': return { view: categoryPage(ctx, service, args.forDraft === 1 ? 'Choose a category' : 'Choose a category to manage.', Number(args.offset ?? 0), args.forDraft === 1) };
      case 'rank': return { view: rankingView(ctx, service, text('categoryId'), Number(args.offset ?? 0)) };
      case 'place': return { view: placeView(ctx, service, text('placeId')) };
      case 'manage': return { view: manageView(ctx, service, text('placeId')) };
      case 'move': {
        const place = service.execute({ action: 'place', place_id: text('placeId') }).place;
        const categories = service.execute({ action: 'categories' }).categories as Category[];
        const offset = Number(args.offset ?? 0);
        const buttons: Buttons = categories.slice(offset, offset + PAGE).map(category => [mint(ctx, category.name, 'reposition', { placeId: place.id, categoryId: category.id })]);
        const nav: Array<{ text: string; callback: string }> = [];
        if (offset > 0) nav.push(mint(ctx, 'Previous', 'move', { placeId: place.id, offset: Math.max(0, offset - PAGE) }));
        if (offset + PAGE < categories.length) nav.push(mint(ctx, 'Next', 'move', { placeId: place.id, offset: offset + PAGE }));
        if (nav.length) buttons.push(nav);
        buttons.push([mint(ctx, 'Menu', 'menu')]);
        return { view: { text: `Choose a category for ${place.name}.`, buttons } };
      }
      case 'rerank': {
        const place = service.execute({ action: 'place', place_id: text('placeId') }).place;
        return { view: { text: 'Choose your overall impression.', buttons: SENTIMENTS.map(sentiment => [mint(ctx, sentiment, 'reposition', { placeId: place.id, sentiment })]) } };
      }
      case 'manageCategories': return { view: categoryPage(ctx, service, 'Choose a category to manage.', 0, false) };
      case 'manageCategory': {
        const category = (service.execute({ action: 'categories' }).categories as Category[]).find(entry => entry.id === text('categoryId'));
        if (!category) throw new PlacesServiceError('NOT_FOUND', 'That category no longer exists.');
        return { view: { text: 'Rename this category.', buttons: [
          [mint(ctx, 'Rename', 'ask', { kind: 'renameCategory', targetId: category.id })],
          ...(mutationsEnabled ? [[mint(ctx, 'Delete category', 'confirmAsk', { operation: 'delete_category', categoryId: category.id, label: clean(category.name, 80) })]] : []),
        ] } };
      }
      case 'confirmAsk': {
        const operation = text('operation') as ConfirmationOperation;
        if (!OPERATIONS.includes(operation)) throw new PlacesServiceError('INVALID_ACTION', 'That action is unavailable.');
        const prepared = service.prepareConfirmation({ action: 'request_confirmation', confirmation_operation: operation,
          ...(args.insertionId !== undefined ? { insertion_id: text('insertionId') } : {}), ...(args.revision !== undefined ? { revision: Number(args.revision) } : {}),
          ...(args.placeId !== undefined ? { place_id: text('placeId') } : {}), ...(args.categoryId !== undefined ? { category_id: text('categoryId') } : {}) });
        return { view: confirmView(ctx, prepared, args.label === undefined ? undefined : text('label')) };
      }
      case 'confirmCancel': return { notice: 'Cancelled. Nothing was changed.', view: homeView(ctx, service) };
      case 'confirm': {
        const operation = text('operation') as ConfirmationOperation;
        if (!OPERATIONS.includes(operation)) throw new PlacesServiceError('INVALID_ACTION', 'That action is unavailable.');
        service.confirmPrepared({
          operation,
          ...(args.insertionId !== undefined ? { insertionId: text('insertionId') } : {}), ...(args.revision !== undefined ? { revision: Number(args.revision) } : {}),
          ...(args.placeId !== undefined ? { placeId: text('placeId') } : {}), ...(args.categoryId !== undefined ? { categoryId: text('categoryId') } : {}),
          ...(args.snapCategoryId !== undefined ? { snapshot: { categoryId: text('snapCategoryId'), revision: Number(args.snapRevision) } } : {}),
        });
        const notice = { cancel: 'Ranking cancelled.', undo_addition: 'Addition undone.', delete_place: 'Place deleted.', delete_category: 'Category deleted.' }[operation];
        return { notice, view: homeView(ctx, service) };
      }
      case 'ask': return { view: ask(ctx, service, text('kind'), args.targetId === undefined ? null : text('targetId')) };
      case 'draftCategory': {
        const draft = ctx.state.draft;
        if (!draft) throw new PlacesServiceError('STALE_ACTION', 'This add flow expired. Start again.');
        if (!(service.execute({ action: 'categories' }).categories as Category[]).some(entry => entry.id === text('categoryId'))) throw new PlacesServiceError('NOT_FOUND', 'That category no longer exists.');
        ctx.state.draft = { name: draft.name, categoryId: text('categoryId'), gen: ++ctx.state.draftGen };
        return { view: draftView(ctx, service)! };
      }
      case 'draftSentiment': {
        const draft = ctx.state.draft;
        if (!draft?.categoryId) throw new PlacesServiceError('STALE_ACTION', 'This add flow expired. Start again.');
        const result = service.execute({ action: 'start', name: draft.name, category_id: draft.categoryId, sentiment: text('sentiment') as Sentiment });
        ctx.state.draft = null; ctx.state.draftGen++;
        return { view: resultView(ctx, result) };
      }
      case 'reposition': return { view: resultView(ctx, service.execute({ action: 'reposition', place_id: text('placeId'), ...(args.categoryId ? { category_id: text('categoryId') } : {}), ...(args.sentiment ? { sentiment: text('sentiment') as Sentiment } : {}) })) };
      case 'answer': return { view: resultView(ctx, service.execute({ action: 'answer', insertion_id: text('insertionId'), revision: Number(args.revision), existing_place_id: text('existingPlaceId'), winner: text('winner') as 'candidate' | 'existing' })) };
      case 'back': return { view: resultView(ctx, service.execute({ action: 'back', insertion_id: text('insertionId'), revision: Number(args.revision) })) };
      case 'clearNotes': { service.execute({ action: 'edit_place', place_id: text('placeId'), notes: '' }); return { view: placeView(ctx, service, text('placeId')) }; }
      default: throw new PlacesServiceError('INVALID_ACTION', 'That action is unavailable.');
    }
  }
  function runPrompt(ctx: Ctx, service: PlacesApplication, prompt: PromptRecord, input: string): Outcome {
    const value = input.trim();
    const target = prompt.targetId ?? '';
    switch (prompt.kind) {
      case 'add': case 'newCategory': case 'renameCategory': case 'renamePlace':
        if (!value || value.length > 200) throw new PlacesServiceError('INVALID_ACTION', 'Use a name between 1 and 200 characters.');
    }
    switch (prompt.kind) {
      case 'add': ctx.state.draft = { name: value, categoryId: null, gen: ++ctx.state.draftGen }; return { view: draftView(ctx, service)! };
      case 'newCategory':
        service.execute({ action: 'create_category', name: value });
        return { view: draftView(ctx, service) ?? summariesView(ctx, service) };
      case 'renameCategory': service.execute({ action: 'rename_category', category_id: target, name: value }); return { view: summariesView(ctx, service) };
      case 'renamePlace': service.execute({ action: 'edit_place', place_id: target, name: value }); return { view: placeView(ctx, service, target) };
      case 'notes':
        if (input.length > 4000) throw new PlacesServiceError('INVALID_ACTION', 'Notes must be at most 4000 characters');
        service.execute({ action: 'edit_place', place_id: target, notes: value }); return { view: placeView(ctx, service, target) };
      default: throw new PlacesServiceError('INVALID_ACTION', 'That input is unavailable.');
    }
  }
  /** Runs a domain effect; every failure becomes a visible notice plus the current recoverable view. */
  function guarded(ctx: Ctx, service: PlacesApplication, work: () => Outcome): Delivery {
    let outcome: Outcome;
    try { outcome = work(); }
    catch (error) {
      const stale = error instanceof PlacesServiceError && (error.code === 'STALE_ACTION' || error.code === 'NO_ACTIVE_INSERTION');
      // Keys minted for the failed view are void; only the recovery view's keys are delivered.
      for (const key of ctx.keys) delete ctx.state.actions[key];
      ctx.keys = [];
      if (ctx.promptId) delete ctx.state.prompts[ctx.promptId];
      ctx.promptId = null;
      outcome = { notice: stale ? 'That step is no longer current. Here is where things stand.' : escapeError(error), view: homeView(ctx, service) };
    }
    return deliveryOf(ctx, withNotice(outcome.notice, outcome.view));
  }
  const interrupted = (ctx: Ctx, service: PlacesApplication): Delivery => {
    const view = homeView(ctx, service);
    return deliveryOf(ctx, withNotice('That action was interrupted before its result was recorded. It may or may not have been applied. View rankings to inspect saved places before trying again.', {
      ...view, buttons: [...(view.buttons ?? []), [mint(ctx, 'View rankings', 'summaries')]],
    }));
  };

  // ---- Delivery ------------------------------------------------------------
  async function deliver(owner: { action: string } | { prompt: string } | null, delivery: Delivery): Promise<void> {
    const sent = await options.present(target, { text: delivery.text, ...(delivery.buttons.length ? { buttons: delivery.buttons } : {}) });
    if (!Number.isSafeInteger(sent.messageId) || sent.messageId <= 0) throw new Error('Telegram presentation receipt missing');
    await track(root().commit(async tx => {
      const state = await tx.doc(PlacesNative, root().id);
      for (const key of delivery.keys) { const record = state.actions[key]; if (record && record.state === 'issued' && record.messageId === null) record.messageId = sent.messageId; }
      if (delivery.promptId) { (state.promptMessages ??= {})[String(sent.messageId)] = true; const prompt = state.prompts[delivery.promptId]; if (prompt && prompt.messageId === null) prompt.messageId = sent.messageId; }
      if (owner && 'action' in owner) { const record = state.actions[owner.action]; if (record?.delivery) record.delivery.presented = true; }
      if (owner && 'prompt' in owner) { const prompt = state.prompts[owner.prompt]; if (prompt?.delivery) prompt.delivery.presented = true; }
    }));
  }

  // ---- Direct entry points ----------------------------------------------------
  async function command(request: UiOrigin): Promise<UiResult> {
    assertOpen();
    if (!originOk(request)) throw new UiRejectedError('This action is unavailable.');
    const service = app();
    const delivery = await locked(() => root().commit(async tx => {
      const authorityNow = await authority(tx);
      if (!authorityNow) throw new UiRejectedError('This action is unavailable.');
      const state = await tx.doc(PlacesNative, root().id);
      prune(state); cancelPending(state);
      const ctx: Ctx = { state, epoch: authorityNow.epoch, keys: [], promptId: null };
      return deliveryOf(ctx, homeView(ctx, service));
    }));
    await track(deliver(null, delivery));
    return {};
  }

  async function callback(request: PlacesCallbackRequest): Promise<UiResult> {
    assertOpen();
    if (!originOk(request)) throw new UiRejectedError('This action is unavailable.');
    const service = app();
    const key = request.key;
    type Claim = { kind: 'run'; op: string; args: Args } | { kind: 'replay'; delivery: Delivery | null; op: string; args: Args } | { kind: 'reject'; message: string };
    const claim = await locked(() => root().commit(async (tx): Promise<Claim> => {
      const authorityNow = await authority(tx);
      const state = await tx.doc(PlacesNative, root().id);
      const record = state.actions[key];
      const unavailable: Claim = { kind: 'reject', message: 'This button expired. Open /place_rankings again.' };
      if (!record || record.principal !== request.principal || record.actorId !== request.actorId || record.chatId !== request.target.chatId) return unavailable;
      if (!authorityNow || record.epoch !== authorityNow.epoch || record.expiresAt <= now() || record.state === 'expired') return unavailable;
      if (record.state === 'claimed' || record.state === 'done') {
        if (record.commandId !== request.commandId || record.messageId !== request.messageId) return { kind: 'reject', message: 'That button was already used.' } satisfies Claim;
        return { kind: 'replay', delivery: plain(record.delivery), op: record.op, args: plain(record.args) };
      }
      if (record.state !== 'issued' || record.messageId === null || record.messageId !== request.messageId || record.expiresAt <= now()) return unavailable;
      if (!authorityNow || record.epoch !== authorityNow.epoch) return unavailable;
      if (record.draftGen !== null && record.draftGen !== state.draft?.gen) return { kind: 'reject', message: 'This add step expired. Open /place_rankings to continue.' } satisfies Claim;
      const group = record.args.grp;
      if (typeof group === 'string') for (const other of Object.values(state.actions)) if (other.key !== key && other.args.grp === group && other.state === 'issued') other.state = 'expired';
      record.state = 'claimed';
      record.commandId = request.commandId;
      return { kind: 'run', op: record.op, args: plain(record.args) } satisfies Claim;
    }));
    if (claim.kind === 'reject') throw new UiRejectedError(claim.message);
    let delivery: Delivery | null;
    if (claim.kind === 'replay') {
      const record = await root().commit(async tx => { const r = (await tx.doc(PlacesNative, root().id)).actions[key]; return r ? { state: r.state, delivery: r.delivery ? JSON.parse(JSON.stringify(r.delivery)) as Delivery : null } : null; });
      if (record?.state === 'done' && record.delivery) {
        if (record.delivery.presented) return { toast: 'Already applied' };
        delivery = record.delivery;
      } else {
        // Claimed without a recorded result. A read runs again; a write may or may not have happened and is never repeated.
        delivery = await effectCommit(key, request, claim.op, claim.args, service, !READ_OPS.has(claim.op));
      }
    } else {
      delivery = await effectCommit(key, request, claim.op, claim.args, service, false);
    }
    if (!delivery) throw new UiRejectedError('This button expired. Open /place_rankings again.');
    // One in-flight presentation per capability: a concurrent exact redelivery waits instead of sending a second message.
    const running = delivering.get(key);
    if (running) { try { await running; return { toast: 'Already applied' }; } catch { /* The first attempt failed; try again below. */ } }
    const sending = track(deliver({ action: key }, delivery));
    delivering.set(key, sending);
    try { await sending; }
    catch { return { toast: 'Could not send the next step. Open /place_rankings.' }; }
    finally { if (delivering.get(key) === sending) delivering.delete(key); }
    return {};
  }

  /** Second commit: re-checks current identity, runs the domain effect synchronously, persists the result. */
  async function effectCommit(key: string, request: UiOrigin, op: string, args: Args, service: PlacesApplication, wasInterrupted: boolean): Promise<Delivery | null> {
    return locked(() => root().commit(async tx => {
      const state = await tx.doc(PlacesNative, root().id);
      const record = state.actions[key];
      if (!record || record.commandId !== request.commandId || record.state === 'expired' || record.expiresAt <= now()) return null;
      if (record.state === 'done') return record.delivery;
      const authorityNow = await authority(tx);
      const ctx: Ctx = { state, epoch: authorityNow?.epoch ?? record.epoch, keys: [], promptId: null };
      let delivery: Delivery;
      if (!authorityNow || authorityNow.epoch !== record.epoch || (record.draftGen !== null && record.draftGen !== state.draft?.gen)) {
        delivery = { text: 'This action expired. Open /place_rankings to inspect the current state.', buttons: [], keys: [], promptId: null, presented: false };
      } else if (wasInterrupted && !READ_OPS.has(op)) delivery = interrupted(ctx, service);
      else delivery = guarded(ctx, service, () => runAction(ctx, service, op, args));
      record.state = 'done';
      record.delivery = delivery;
      prune(state);
      return delivery;
    }));
  }

  async function input(request: PlacesInputRequest): Promise<boolean> {
    assertOpen();
    if (!originOk(request)) return false;
    const service = app();
    type Claim = { kind: 'none' } | { kind: 'notice'; message: string } | { kind: 'replay'; delivery: Delivery | null; interrupted: boolean } | { kind: 'run'; prompt: PromptRecord };
    const claim = await locked(() => root().commit(async (tx): Promise<Claim> => {
      const state = await tx.doc(PlacesNative, root().id);
      const prompt = Object.values(state.prompts).find(item => item.messageId === request.replyToMessageId && item.chatId === request.target.chatId);
      const inactive = { kind: 'notice', message: 'That input request is no longer active. Open /place_rankings to continue.' } as const;
      if (!prompt) return state.promptMessages?.[String(request.replyToMessageId)] || isOwnPrompt(request.trustedPromptText) ? inactive : { kind: 'none' } satisfies Claim;
      const authorityNow = await authority(tx);
      if (!authorityNow || authorityNow.epoch !== prompt.epoch || prompt.expiresAt <= now() || request.messageId <= request.replyToMessageId) return inactive;
      if (prompt.state === 'consumed') {
        if (prompt.commandId === request.commandId) return { kind: 'replay', delivery: plain(prompt.delivery), interrupted: prompt.delivery === null } satisfies Claim;
        return { kind: 'notice', message: 'That input was already received.' } satisfies Claim;
      }
      if (prompt.state !== 'pending' || prompt.expiresAt <= now() || !authorityNow || authorityNow.epoch !== prompt.epoch || prompt.principal !== request.principal || prompt.actorId !== request.actorId
        || (prompt.draftGen !== null && prompt.draftGen !== state.draft?.gen)) {
        prompt.state = prompt.state === 'pending' ? 'cancelled' : prompt.state;
        return { kind: 'notice', message: 'That input request is no longer active. Open /place_rankings to continue.' } satisfies Claim;
      }
      prompt.state = 'consumed';
      prompt.commandId = request.commandId;
      return { kind: 'run', prompt: { ...prompt } } satisfies Claim;
    }));
    if (claim.kind === 'none') return false;
    const safely = async (work: () => Promise<unknown>) => { try { await work(); } catch { /* The reply is consumed; delivery failure never reaches the model. */ } };
    if (claim.kind === 'notice') { await safely(() => track(options.present(target, { text: claim.message }))); return true; }
    let delivery: Delivery | null;
    const prompt = claim.kind === 'run' ? claim.prompt : await root().commit(async tx => { const found = Object.values((await tx.doc(PlacesNative, root().id)).prompts).find(item => item.messageId === request.replyToMessageId); return found ? JSON.parse(JSON.stringify(found)) as PromptRecord : undefined; });
    if (!prompt) return true;
    if (claim.kind === 'replay' && claim.delivery) {
      if (claim.delivery.presented) return true;
      delivery = claim.delivery;
    } else {
      const wasInterrupted = claim.kind === 'replay';
      delivery = await locked(() => root().commit(async tx => {
        const state = await tx.doc(PlacesNative, root().id);
        const record = state.prompts[prompt.id];
        if (!record || record.commandId !== request.commandId || record.state !== 'consumed' || record.expiresAt <= now()) return null;
        if (record.delivery) return record.delivery;
        const authorityNow = await authority(tx);
        const ctx: Ctx = { state, epoch: authorityNow?.epoch ?? record.epoch, keys: [], promptId: null };
        let result: Delivery;
        if (!authorityNow || authorityNow.epoch !== record.epoch || (record.draftGen !== null && record.draftGen !== state.draft?.gen)) result = { text: 'That input expired. Open /place_rankings to inspect the current state.', buttons: [], keys: [], promptId: null, presented: false };
        else if (wasInterrupted) result = interrupted(ctx, service);
        else result = guarded(ctx, service, () => runPrompt(ctx, service, record, request.text));
        record.delivery = result;
        prune(state);
        return result;
      }));
    }
    if (delivery) { const sent = delivery; await safely(() => track(deliver({ prompt: prompt.id }, sent))); }
    else await safely(() => options.present(target, { text: 'That input request is no longer active. Open /place_rankings to continue.' }));
    return true;
  }

  async function invalidate(): Promise<void> {
    if (closed) return;
    await track(root().commit(async tx => {
      const state = await tx.doc(PlacesNative, root().id);
      for (const record of Object.values(state.actions)) record.state = 'expired';
      for (const prompt of Object.values(state.prompts)) prompt.state = 'cancelled';
    }));
  }

  // ---- Model tool -------------------------------------------------------------
  type Failure = { ok: false; error: { code: string; message: string } };
  async function runTool(raw: unknown, api: { conversationId: ConversationId; commit<T>(change: (tx: Tx) => T | Promise<T>, ctx: Context): Promise<T> }): Promise<{ details: unknown; terminate: boolean; isError: boolean }> {
    const fail = (code: string, message: string): { details: Failure; terminate: false; isError: true } => ({ details: { ok: false, error: { code, message } }, terminate: false, isError: true });
    let params: PlacesCommand;
    try { params = validateToolArguments({ name: 'rank_places', description: PLACES_TOOL_DESCRIPTION, parameters: placesToolParameters }, { type: 'toolCall', id: 'validation', name: 'rank_places', arguments: raw as Record<string, never> }) as PlacesCommand; }
    catch { return fail('INVALID_ACTION', 'Invalid places action'); }
    if (!mutationsEnabled && (DESTRUCTIVE_ACTIONS.has(params.action) || params.action === 'request_confirmation')) return fail('UNAVAILABLE', 'That change is unavailable until the guarded-mutation slice. Nothing was changed.');
    if (DESTRUCTIVE_ACTIONS.has(params.action)) return fail('CONFIRMATION_REQUIRED', 'Only the user can approve this change. Call request_confirmation to show them Confirm and Cancel buttons. Nothing was changed.');
    let service: PlacesApplication;
    try { service = app(); } catch { return fail('UNAVAILABLE', 'Places is unavailable outside the configured bridge runtime.'); }
    const present = params.action === 'start' || params.action === 'answer' || params.action === 'back' || params.action === 'reposition' || params.action === 'resume' || params.action === 'menu'
      || (params.action === 'categories' && params.name !== undefined);
    type Outcome2 = { kind: 'unauthorized' } | { kind: 'failure'; code: string; message: string; existing?: { id: string; name: string } } | { kind: 'ok'; result: unknown; delivery: Delivery | null; stale?: boolean };
    const outcome = await locked(() => api.commit(async (tx): Promise<Outcome2> => {
      const authorityNow = await authority(tx, api.conversationId);
      if (!authorityNow) return { kind: 'unauthorized' } satisfies Outcome2;
      const state = await tx.doc(PlacesNative, root().id);
      prune(state);
      const ctx: Ctx = { state, epoch: authorityNow.epoch, keys: [], promptId: null };
      let result: unknown;
      let stale = false;
      try {
        if (params.action === 'request_confirmation') {
          if (!params.confirmation_operation) throw new PlacesServiceError('INVALID_ACTION', 'request_confirmation requires confirmation_operation');
          const prepared = service.prepareConfirmation({ ...params, confirmation_operation: params.confirmation_operation });
          let label: string | undefined;
          if (prepared.placeId) label = service.execute({ action: 'place', place_id: prepared.placeId }).place.name;
          if (prepared.categoryId) label = (service.execute({ action: 'categories' }).categories as Category[]).find(entry => entry.id === prepared.categoryId)?.name;
          cancelPending(state);
          const delivery = deliveryOf(ctx, confirmView(ctx, prepared, label === undefined ? undefined : clean(label, 80)));
          return { kind: 'ok', result: { kind: 'confirmation_requested', operation: prepared.operation }, delivery } satisfies Outcome2;
        }
        result = service.execute(params);
      }
      catch (error) {
        const safe = error instanceof PlacesServiceError ? error : new PlacesServiceError('INVALID_ACTION', error instanceof Error ? error.message : 'Invalid places action');
        if ((safe.code === 'STALE_ACTION' || safe.code === 'NO_ACTIVE_INSERTION') && (params.action === 'answer' || params.action === 'back')) {
          stale = true;
          try { result = service.execute({ action: 'resume' }); } catch { result = null; }
        } else if (safe.code === 'DUPLICATE_PLACE' && params.action === 'start' && params.category_id && params.name) {
          const normalized = normalizePlaceName(params.name);
          let existing: { id: string; name: string } | undefined;
          for (let offset = 0; !existing; offset += 50) {
            const page = service.execute({ action: 'ranking', category_id: params.category_id, offset, limit: 50 });
            existing = page.places.find(place => place.normalizedName === normalized);
            if (!page.hasNext) break;
          }
          return { kind: 'failure', code: safe.code, message: safe.message, ...(existing ? { existing: { id: existing.id, name: existing.name } } : {}) } satisfies Outcome2;
        } else return { kind: 'failure', code: safe.code, message: safe.message } satisfies Outcome2;
      }
      let delivery: Delivery | null = null;
      if (present) {
        cancelPending(state);
        let view: Presentation | undefined;
        if (params.action === 'categories') {
          state.draft = { name: params.name!, categoryId: null, gen: ++state.draftGen };
          view = draftView(ctx, service);
        } else {
          if (params.action === 'start') { state.draft = null; state.draftGen++; }
          view = params.action === 'menu' || params.action === 'resume' || result === null ? homeView(ctx, service) : resultView(ctx, result);
        }
        if (view) delivery = deliveryOf(ctx, view);
      }
      return { kind: 'ok', result, delivery, ...(stale ? { stale } : {}) } satisfies Outcome2;
    }, context));
    if (outcome.kind === 'unauthorized') return fail('UNAVAILABLE', 'Places requires the current private conversation.');
    if (outcome.kind === 'failure') return { details: { ok: false, error: { code: outcome.code, message: outcome.message }, ...(outcome.existing ? { existing: outcome.existing } : {}) }, terminate: false, isError: true };
    let presented = false;
    if (outcome.delivery) {
      try { await track(deliver(null, outcome.delivery)); presented = true; } catch { presented = false; }
    }
    if (params.action === 'request_confirmation' && !presented) return fail('PRESENTATION_FAILED', 'The confirmation prompt could not be delivered to the user. Nothing was changed.');
    const result = outcome.stale ? { kind: 'stale', message: 'That ranking action is stale. Resume the current comparison and try again.', current: outcome.result, restartRequired: outcome.result === null } : outcome.result;
    return { details: { ok: true, result, presented }, terminate: presented, isError: false };
  }

  function bundle(): NativeBundle {
    if (config.principal !== 'isaac') throw new Error('Places is available only to the isaac principal');
    return {
      name: 'places', version: mutationsEnabled ? 2 : 1,
      tools: [{ version: mutationsEnabled ? 2 : 1, tool: defineTool({
        name: 'rank_places', description, parameters: placesToolParameters, replay: 'unsafe',
        execute: async (raw, api) => {
          const { details, terminate, isError } = await track(runTool(raw, api as never));
          return { ...textToolResult(details as never, isError), ...(terminate ? { control: { terminate: true as const } } : {}) };
        },
      }) }],
      close,
    };
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...inflight]);
      const open = domain;
      domain = undefined;
      open?.store.close();
    })();
    return closing;
  }

  // Track whole operations, including claims and queued effects, before close can drain them.
  const entry = <A, R>(work: (request: A) => Promise<R>) => (request: A): Promise<R> => {
    if (closed) return Promise.reject(new Error('Places is closed'));
    return track(work(request));
  };
  return { bundle, command: entry(command), callback: entry(callback), input: entry(input), invalidate: () => closed ? Promise.resolve() : track(invalidate()), close };
}
export type NativePlaces = ReturnType<typeof createNativePlaces>;
