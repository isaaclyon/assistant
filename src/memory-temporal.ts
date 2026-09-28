import { extractAbsoluteDateRanges, type DateRange } from "./date-context.js";
import type { IndexedMemorySearchRequest } from "./search-coordinator.js";
import type { MemoryDocumentSearchMatch, SearchIndex } from "./search-index.js";

/** Same canonical refresh and visibility contract as hybrid retrieval. Dates
 * come from note content, never filesystem/created/updated timestamps. */
export function searchTemporalMemories(
  index: SearchIndex,
  request: IndexedMemorySearchRequest,
  ranges: readonly DateRange[],
): MemoryDocumentSearchMatch[] {
  if (!ranges.length) return [];
  const best = new Map<string, MemoryDocumentSearchMatch>();
  const terms = [...new Set(request.query.toLowerCase().match(/\p{L}{4,}/gu) ?? [])];
  for (const chunk of index.semantic.chunks(request)) {
    // Source provenance is not the date of the event described by a note.
    const text = chunk.input.replace(/^\[\^[^\]]+\]:[^\n]*/gm, "");
    if (!/\b\d{4}\b/.test(text)) continue;
    const match = extractAbsoluteDateRanges(text).find((date) =>
      ranges.some((range) => date.start <= range.end && date.end >= range.start));
    if (!match) continue;
    const score = terms.filter((term) => text.toLowerCase().includes(term)).length;
    const previous = best.get(chunk.note.id);
    if (previous && previous.score >= score) continue;
    const offset = Math.max(0, match.index - 100);
    best.set(chunk.note.id, { ...chunk.note, score,
      snippet: `${match.start} through ${match.end}: ${text.slice(offset, offset + 300).trim()}` });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, request.limit ?? 8);
}

/** Reserve room for both content matches and overlapping dates. */
export function mergeTemporalCandidates<T extends { id: string }>(
  content: readonly T[], temporal: readonly T[], limit: number,
): T[] {
  const merged = new Map<string, T>();
  for (let rank = 0; merged.size < limit && (rank < content.length || rank < temporal.length); rank += 1) {
    for (const candidate of [temporal[rank], content[rank]]) {
      if (candidate && !merged.has(candidate.id) && merged.size < limit) merged.set(candidate.id, candidate);
    }
  }
  return [...merged.values()];
}
