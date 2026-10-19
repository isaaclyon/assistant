import type { NativeHistoryEntry, NativeHistoryStore } from '../../src/durable/history.js';

export interface FakeStore extends NativeHistoryStore {
  entries: Map<number, NativeHistoryEntry[]>;
  visible: Set<number>;
  add(conversationId: number, entry: Omit<NativeHistoryEntry, 'conversationId'>): void;
}

export const T0 = Date.UTC(2026, 6, 19, 3, 30, 0);
export const iso = (ms: number) => new Date(ms).toISOString();
export const user = (id: number, text: string, originalAt = T0 + id * 1000): Omit<NativeHistoryEntry, 'conversationId'> => ({
  id, kind: 'bridge.source', data: { sourceId: `s${id}`, originalAt },
  model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: originalAt + 5 }],
});
export const assistant = (id: number, text: string): Omit<NativeHistoryEntry, 'conversationId'> => ({
  id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }], timestamp: T0 + id * 1000 }],
});
export const toolResult = (id: number, toolName: string, text: string): Omit<NativeHistoryEntry, 'conversationId'> => ({
  id, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolName, content: [{ type: 'text', text }], timestamp: T0 + id * 1000 }],
});

/** In-memory native store. Entry ids are global numbers, as in the real store. */
export function fakeStore(identity: { instanceId?: string; storeId?: string; principal?: string } = {}): FakeStore {
  const entries = new Map<number, NativeHistoryEntry[]>();
  const visible = new Set<number>();
  return {
    instanceId: identity.instanceId ?? 'inst', storeId: identity.storeId ?? 'main', principal: identity.principal ?? 'isaac',
    entries, visible,
    add(conversationId, entry) { (entries.get(conversationId) ?? entries.set(conversationId, []).get(conversationId)!).push({ ...entry, conversationId }); visible.add(conversationId); },
    async conversations() { return [...visible].sort((a, b) => a - b); },
    async scan(conversationId, query) {
      const all = (entries.get(conversationId) ?? []).filter(e => (query.minEntryId === undefined || e.id >= query.minEntryId) && (query.maxEntryId === undefined || e.id <= query.maxEntryId));
      return (query.order === 'ascending' ? all : [...all].reverse()).slice(0, query.limit);
    },
    async entry(conversationId, entryId) { return entries.get(conversationId)?.find(e => e.id === entryId); },
  };
}
