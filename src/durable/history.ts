import { DEFAULT_ANCHOR_LIMITS, resolveLegacyAnchors, type AnchorFinding, type LegacyAnchor } from './history-legacy.js';
import { DEFAULT_EVIDENCE_POLICY, projectNativeEntry, type EvidencePolicy, type NativeEvidence, type NativeHistoryStore } from './history-native.js';
export type { AnchorFinding, LegacyAnchor } from './history-legacy.js';
export { createHarnessHistoryStore, DEFAULT_EVIDENCE_POLICY, projectNativeEntry, type EvidencePolicy, type NativeEvidence, type NativeHistoryEntry, type NativeHistoryStore } from './history-native.js';

/**
 * Durable history locators.
 *
 * Archived JSONL evidence keeps its original `session id / entry id / timestamp` anchor. Native evidence uses the same three
 * fields so existing tools and Markdown footnotes need no new syntax: the session id encodes backend, instance, store and
 * conversation, the entry id is the native entry id, and the timestamp is the source event time. No file path is fabricated,
 * and no locator can name a path.
 */
export const NATIVE_SESSION_PREFIX = 'durable.v1.';
const MAX_SESSION_ID_LENGTH = 256;
const NATIVE_NUMBER = /^[1-9][0-9]{0,15}$/u;

export interface NativeSessionIdentity { instanceId: string; storeId: string; conversationId: number }
export type HistoryLocator =
  | ({ backend: 'durable'; entryId: number; timestamp: string } & NativeSessionIdentity)
  | { backend: 'jsonl'; sessionId: string; entryId: string; timestamp: string };

const part = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
export function encodeNativeSessionId(identity: NativeSessionIdentity): string {
  if (!identity.instanceId || !identity.storeId || !Number.isSafeInteger(identity.conversationId) || identity.conversationId < 1) throw new Error('Invalid native session identity');
  const id = `${NATIVE_SESSION_PREFIX}${part(identity.instanceId)}.${part(identity.storeId)}.${identity.conversationId}`;
  if (id.length > MAX_SESSION_ID_LENGTH) throw new Error('Native session identity is too long');
  return id;
}
/** Strict inverse of `encodeNativeSessionId`; anything non-canonical is rejected. */
export function decodeNativeSessionId(sessionId: string): NativeSessionIdentity | undefined {
  if (!sessionId.startsWith(NATIVE_SESSION_PREFIX) || sessionId.length > MAX_SESSION_ID_LENGTH) return undefined;
  const fields = sessionId.slice(NATIVE_SESSION_PREFIX.length).split('.');
  if (fields.length !== 3 || !NATIVE_NUMBER.test(fields[2]!)) return undefined;
  const instanceId = Buffer.from(fields[0]!, 'base64url').toString('utf8');
  const storeId = Buffer.from(fields[1]!, 'base64url').toString('utf8');
  const conversationId = Number(fields[2]);
  if (!instanceId || !storeId || !Number.isSafeInteger(conversationId)) return undefined;
  const identity = { instanceId, storeId, conversationId };
  return encodeNativeSessionId(identity) === sessionId ? identity : undefined;
}
export const isNativeSessionId = (sessionId: string): boolean => sessionId.startsWith(NATIVE_SESSION_PREFIX);
export function parseNativeEntryId(entryId: string): number | undefined {
  if (!NATIVE_NUMBER.test(entryId)) return undefined;
  const value = Number(entryId);
  return Number.isSafeInteger(value) ? value : undefined;
}
export function nativeLocator(identity: NativeSessionIdentity, evidence: Pick<NativeEvidence, 'entryId' | 'timestamp'>): HistoryLocator {
  return { backend: 'durable', ...identity, entryId: evidence.entryId, timestamp: evidence.timestamp };
}
/** The three-field citation that tools and notes carry for either backend. */
export function citationFor(locator: HistoryLocator): { sessionId: string; entryId: string; timestamp: string } {
  return locator.backend === 'jsonl'
    ? { sessionId: locator.sessionId, entryId: locator.entryId, timestamp: locator.timestamp }
    : { sessionId: encodeNativeSessionId(locator), entryId: String(locator.entryId), timestamp: locator.timestamp };
}
export function locatorFromCitation(citation: { sessionId: string; entryId: string; timestamp: string }): HistoryLocator | undefined {
  if (!isNativeSessionId(citation.sessionId)) return { backend: 'jsonl', ...citation };
  const identity = decodeNativeSessionId(citation.sessionId);
  const entryId = parseNativeEntryId(citation.entryId);
  return identity && entryId !== undefined ? { backend: 'durable', ...identity, entryId, timestamp: citation.timestamp } : undefined;
}

const MAX_CONTEXT_SCAN = 600;
const SCAN_PAGE = 50;

export interface ResolvedNativeEntry { store: NativeHistoryStore; identity: NativeSessionIdentity; evidence: NativeEvidence }
export interface NativeContextWindow {
  identity: NativeSessionIdentity;
  target: NativeEvidence;
  before: NativeEvidence[];
  after: NativeEvidence[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface HistoryResolverOptions {
  /** Principal every read is bound to. Stores for other principals are ignored. */
  principal: string;
  /** Resolved lazily: the host and its stores exist only after construction. */
  nativeStores: () => readonly NativeHistoryStore[];
  /** Archived read-only JSONL session roots. */
  legacyRoots?: readonly string[];
  policy?: EvidencePolicy;
}

export interface HistoryResolver {
  /** Visible native evidence for a citation, or undefined for any unknown, foreign, hidden or mismatched anchor. */
  resolveNative(sessionId: string, entryId: string, timestamp?: string): Promise<ResolvedNativeEntry | undefined>;
  readNativeContext(sessionId: string, entryId: string, before: number, after: number): Promise<NativeContextWindow | undefined>;
  /** Provenance findings in lint vocabulary for both backends; null means the anchor resolves. */
  resolveAnchors(anchors: readonly LegacyAnchor[], limits?: { maxBytes: number; maxEntries: number }): Promise<Array<AnchorFinding | null>>;
}

export function createHistoryResolver(options: HistoryResolverOptions): HistoryResolver {
  const policy = options.policy ?? DEFAULT_EVIDENCE_POLICY;
  const stores = () => options.nativeStores().filter(store => store.principal === options.principal);
  async function locate(sessionId: string) {
    const identity = decodeNativeSessionId(sessionId);
    if (!identity) return undefined;
    const store = stores().find(candidate => candidate.instanceId === identity.instanceId && candidate.storeId === identity.storeId);
    // Current visibility, not the visibility at citation time.
    if (!store || !(await store.conversations()).includes(identity.conversationId)) return undefined;
    return { store, identity };
  }
  async function resolveNative(sessionId: string, entryId: string, timestamp?: string): Promise<ResolvedNativeEntry | undefined> {
    const found = await locate(sessionId);
    const id = parseNativeEntryId(entryId);
    if (!found || id === undefined) return undefined;
    const evidence = projectNativeEntry((await found.store.entry(found.identity.conversationId, id)) ?? { id: 0, conversationId: 0, kind: '' }, policy);
    if (!evidence || evidence.conversationId !== found.identity.conversationId) return undefined;
    if (timestamp !== undefined && evidence.timestamp !== timestamp) return undefined;
    return { ...found, evidence };
  }
  async function collect(found: { store: NativeHistoryStore; identity: NativeSessionIdentity }, from: number, order: 'ascending' | 'descending', wanted: number) {
    const picked: NativeEvidence[] = [];
    let scanned = 0;
    let cursor = from;
    let exhausted = false;
    while (picked.length <= wanted && scanned < MAX_CONTEXT_SCAN) {
      const page = await found.store.scan(found.identity.conversationId, {
        order, limit: SCAN_PAGE,
        ...(order === 'ascending' ? { minEntryId: cursor } : { maxEntryId: cursor }),
      });
      for (const entry of page) {
        const evidence = projectNativeEntry(entry, policy);
        if (evidence && evidence.conversationId === found.identity.conversationId) picked.push(evidence);
      }
      scanned += page.length;
      if (page.length < SCAN_PAGE) { exhausted = true; break; }
      cursor = order === 'ascending' ? page[page.length - 1]!.id + 1 : page[page.length - 1]!.id - 1;
      if (cursor < 1) { exhausted = true; break; }
    }
    // Reaching the scan bound without proof of the end is reported as more history.
    return { picked: picked.slice(0, wanted), more: picked.length > wanted || !exhausted };
  }
  return {
    resolveNative,
    async readNativeContext(sessionId, entryId, before, after) {
      const target = await resolveNative(sessionId, entryId);
      if (!target) return undefined;
      const id = target.evidence.entryId;
      const [prior, next] = await Promise.all([
        before === 0 || id <= 1 ? Promise.resolve({ picked: [] as NativeEvidence[], more: false }) : collect(target, id - 1, 'descending', before),
        after === 0 ? Promise.resolve({ picked: [] as NativeEvidence[], more: false }) : collect(target, id + 1, 'ascending', after),
      ]);
      // A zero-width request still reports whether neighbours exist.
      const probe = async (order: 'ascending' | 'descending', requested: number) => requested > 0 ? undefined : (await collect(target, order === 'ascending' ? id + 1 : Math.max(1, id - 1), order, 1)).picked.length > 0 && !(order === 'descending' && id <= 1);
      const [moreBefore, moreAfter] = await Promise.all([probe('descending', before), probe('ascending', after)]);
      return {
        identity: target.identity, target: target.evidence,
        before: prior.picked.reverse(), after: next.picked,
        hasMoreBefore: moreBefore ?? prior.more, hasMoreAfter: moreAfter ?? next.more,
      };
    },
    async resolveAnchors(anchors, limits = DEFAULT_ANCHOR_LIMITS) {
      const findings: Array<AnchorFinding | null> = anchors.map(() => null);
      const legacy: Array<{ index: number; anchor: LegacyAnchor }> = [];
      for (const [index, anchor] of anchors.entries()) {
        if (!isNativeSessionId(anchor.sessionId)) { legacy.push({ index, anchor }); continue; }
        if (!decodeNativeSessionId(anchor.sessionId) || parseNativeEntryId(anchor.entryId) === undefined) { findings[index] = 'SOURCE_SESSION_INVALID'; continue; }
        const found = await locate(anchor.sessionId);
        if (!found) { findings[index] = 'SOURCE_SESSION_NOT_FOUND'; continue; }
        const resolved = await resolveNative(anchor.sessionId, anchor.entryId);
        if (!resolved) findings[index] = 'SOURCE_ENTRY_NOT_FOUND';
        else if (resolved.evidence.timestamp !== anchor.timestamp) findings[index] = 'SOURCE_TIMESTAMP_MISMATCH';
      }
      if (legacy.length > 0) {
        const results = await resolveLegacyAnchors(options.legacyRoots ?? [], legacy.map(item => item.anchor), limits);
        for (const [position, item] of legacy.entries()) findings[item.index] = results[position] ?? null;
      }
      return findings;
    },
  };
}
