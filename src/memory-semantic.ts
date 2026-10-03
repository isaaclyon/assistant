import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { searchIndexedMemories, type IndexedMemorySearchRequest } from "./search-coordinator.js";
import type { MemoryDocumentSearchMatch, MemoryDocumentSearchPage, SearchIndex } from "./search-index.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, normalizeEmbedding, type EmbedTexts } from "./openai-embeddings.js";
import { MAX_DECAY_DROP, rankWithDrops, type MemoryRanking } from "./memory-usage.js";

// Changing the model, dimensions, or chunking invalidates the derived cache.
const CACHE_VERSION = `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}:sections-v1`;
const MAX_NEW_CHUNKS = 32;
/** The embedder accepts 33 inputs: the chunk batch shrinks as queries are added. */
const MAX_QUERIES = 3;

interface MemoryChunk {
  note: MemoryDocumentSearchMatch;
  hash: string;
  input: string;
  snippet: string;
  vector?: number[];
}

export interface MemorySemanticStore {
  chunks(request: IndexedMemorySearchRequest): MemoryChunk[];
  save(chunk: MemoryChunk, vector: number[]): void;
}

function byteParts(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) { parts.push(part); part = ""; bytes = 0; }
    part += character;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

function chunksFor(title: string, tags: string[], body: string): Array<{ input: string; snippet: string }> {
  const prefix = `${byteParts(`${title}\n${tags.join(", ")}`, 800)[0] ?? ""}\n`;
  const chunks: Array<{ input: string; snippet: string }> = [];
  for (const section of (body.trim() || title).split(/(?=^#{1,6} )/m)) {
    if (!section.trim()) continue;
    for (const part of byteParts(section, 6000 - Buffer.byteLength(prefix))) {
      chunks.push({ input: prefix + part, snippet: Array.from(part.trim()).slice(0, 240).join("") });
    }
  }
  return chunks;
}

export function createMemorySemanticStore(db: DatabaseSync): MemorySemanticStore {
  const cached = db.prepare(`SELECT vector FROM memory_embedding
    WHERE note_id = ? AND revision = ? AND chunk_hash = ? AND model = ?`);
  const save = db.prepare(`INSERT OR REPLACE INTO memory_embedding (note_id, revision, chunk_hash, model, vector)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memory_document WHERE note_id = ? AND revision = ?)`);
  return {
    chunks(request) {
      if (request.memoryView === "none") return [];
      const where = [request.memoryView === "household" ? "scope = 'household'"
        : "(scope = 'household' OR (scope = 'personal' AND owner = ?))"];
      const parameters: string[] = request.memoryView === "household" ? [] : [request.principal];
      for (const [field, values] of [["type", request.types], ["status", request.statuses ?? ["active"]]] as const) {
        if (values) {
          where.push(`${field} IN (${values.map(() => "?").join(",")})`);
          parameters.push(...values);
        }
      }
      const documents = db.prepare(`SELECT * FROM memory_document WHERE ${where.join(" AND ")} ORDER BY note_id`).all(...parameters);
      const chunks: MemoryChunk[] = [];
      for (const row of documents) {
        const note: MemoryDocumentSearchMatch = {
          source: "memory", schema: 2, id: String(row.note_id), relativePath: String(row.relative_path),
          type: String(row.type), status: String(row.status), scope: String(row.scope),
          ...(row.owner === null ? {} : { owner: String(row.owner) }), title: String(row.title),
          tags: JSON.parse(String(row.tags_json)) as string[], created: String(row.created_at),
          updated: String(row.updated_at), revision: String(row.revision), score: 0, snippet: "",
        };
        for (const chunk of chunksFor(note.title, note.tags, String(row.body))) {
          const hash = createHash("sha256").update(chunk.input).digest("hex");
          const stored = cached.get(note.id, note.revision, hash, CACHE_VERSION)?.vector;
          let vector: number[] | undefined;
          if (stored instanceof Uint8Array && stored.byteLength === EMBEDDING_DIMENSIONS * 4) {
            try {
              const bytes = Buffer.from(stored);
              vector = normalizeEmbedding(Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => bytes.readFloatLE(i * 4)));
            } catch { /* A corrupt disposable vector is regenerated. */ }
          }
          chunks.push({ note, hash, ...chunk, ...(vector ? { vector } : {}) });
        }
      }
      return chunks;
    },
    save(chunk, vector) {
      const normalized = normalizeEmbedding(vector);
      const bytes = Buffer.alloc(EMBEDDING_DIMENSIONS * 4);
      normalized.forEach((n, i) => bytes.writeFloatLE(n, i * 4));
      save.run(chunk.note.id, chunk.note.revision, chunk.hash, CACHE_VERSION, bytes, chunk.note.id, chunk.note.revision);
    },
  };
}

export interface MemoryEmbeddingPreparation {
  status: "disabled" | "ready" | "partial" | "unavailable";
  queryVector?: number[];
}

/** One bounded batch includes the query and up to 32 missing visible chunks. */
export async function prepareMemoryEmbeddings(
  index: SearchIndex,
  request: IndexedMemorySearchRequest,
  embed: EmbedTexts | undefined,
  includeQuery = true,
): Promise<MemoryEmbeddingPreparation> {
  const prepared = await prepareMemoryQueryEmbeddings(index, request, includeQuery ? [request.query] : [], embed);
  return { status: prepared.status, ...(prepared.queryVectors ? { queryVector: prepared.queryVectors[0]! } : {}) };
}

export interface MemoryQueryEmbeddingPreparation {
  status: MemoryEmbeddingPreparation["status"];
  /** One vector per query, in order, when the batch succeeded. */
  queryVectors?: number[][];
}

/**
 * Embeds several queries with the same visibility filters in one bounded
 * request. Queries share the batch with missing chunks, so the chunk share
 * shrinks to keep the whole request within one embedding call.
 */
export async function prepareMemoryQueryEmbeddings(
  index: SearchIndex,
  request: IndexedMemorySearchRequest,
  queries: readonly string[],
  embed: EmbedTexts | undefined,
): Promise<MemoryQueryEmbeddingPreparation> {
  if (queries.length > MAX_QUERIES) throw new Error("Too many memory queries");
  // Share tool input validation with FTS for the filters and every query.
  searchIndexedMemories(index, request);
  for (const query of queries) searchIndexedMemories(index, { ...request, query });
  if (!embed) return { status: "disabled" };
  const chunks = index.semantic.chunks(request);
  if (chunks.length === 0) return { status: "ready" };
  const missing = chunks.filter((chunk) => !chunk.vector);
  const batch = missing.slice(0, MAX_NEW_CHUNKS + 1 - Math.max(1, queries.length));
  if (queries.length === 0 && batch.length === 0) return { status: "ready" };
  try {
    const inputs = [...queries, ...batch.map((chunk) => chunk.input)];
    const vectors = await embed(inputs);
    if (vectors.length !== inputs.length) throw new Error("Incomplete embedding response");
    const normalized = vectors.map(normalizeEmbedding);
    batch.forEach((chunk, i) => index.semantic.save(chunk, normalized[i + queries.length]!));
    return { status: missing.length > batch.length ? "partial" : "ready",
      ...(queries.length > 0 ? { queryVectors: normalized.slice(0, queries.length) } : {}) };
  } catch {
    return { status: "unavailable" };
  }
}

/** Current revision of every note visible under the request's view and filters. */
export function visibleMemoryRevisions(
  index: SearchIndex,
  request: IndexedMemorySearchRequest,
): Map<string, string> {
  return new Map(index.semantic.chunks(request).map((chunk) => [chunk.note.id, chunk.note.revision]));
}

/**
 * Call only after a successful canonical refresh, including after inference.
 * An optional usage ranking (ADR-0043) moves fading notes down a few places
 * before the result list is trimmed.
 */
export function searchHybridMemories(
  index: SearchIndex,
  request: IndexedMemorySearchRequest,
  prepared: MemoryEmbeddingPreparation,
  ranking?: MemoryRanking,
): MemoryDocumentSearchPage {
  const limit = request.limit ?? 10;
  if (!prepared.queryVector) {
    if (!ranking) return { ...searchIndexedMemories(index, request), retrieval: { mode: "keyword", semantic: prepared.status } };
    // Fetch a few extra so lower notes can move up past dropped ones.
    const page = searchIndexedMemories(index, { ...request, limit: Math.min(50, limit + MAX_DECAY_DROP) });
    const ranked = rankWithDrops(page.results, ranking);
    return { ...page, results: ranked.slice(0, limit), truncated: page.truncated || ranked.length > limit,
      retrieval: { mode: "keyword", semantic: prepared.status } };
  }
  const candidateLimit = Math.max(20, limit);
  const lexical = searchIndexedMemories(index, { ...request, limit: candidateLimit });
  const best = new Map<string, MemoryDocumentSearchMatch>();
  const chunks = index.semantic.chunks(request);
  // ponytail: exact scan suits personal vaults; add an ANN index only after measured scan latency warrants it.
  for (const chunk of chunks) {
    if (!chunk.vector) continue;
    const score = chunk.vector.reduce((sum, n, i) => sum + n * prepared.queryVector![i]!, 0);
    const previous = best.get(chunk.note.id);
    if (!previous || score > previous.score) best.set(chunk.note.id, { ...chunk.note, score, snippet: chunk.snippet });
  }
  const semantic = [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const merged = new Map<string, MemoryDocumentSearchMatch>();
  for (const ranked of [lexical.results, semantic.slice(0, candidateLimit)]) {
    ranked.forEach((result, rank) => {
      const previous = merged.get(result.id);
      merged.set(result.id, { ...(previous ?? result), score: (previous?.score ?? 0) + 1 / (60 + rank + 1) });
    });
  }
  const fused = [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const results = ranking ? rankWithDrops(fused, ranking) : fused;
  return { results: results.slice(0, limit),
    truncated: lexical.truncated || semantic.length > candidateLimit || results.length > limit,
    retrieval: { mode: best.size > 0 ? "hybrid" : "keyword", semantic: chunks.some((chunk) => !chunk.vector) ? "partial" : "ready" },
    ...(lexical.warning ? { warning: lexical.warning } : {}) };
}

/**
 * Runs one hybrid search per query and interleaves the rankings: every query's
 * first result, then every second result, skipping repeats. Summed rank fusion
 * would favor notes that rank moderately across several queries, letting an
 * uninformative query ("ok do it") crowd out another query's best match. Call
 * only after a successful canonical refresh, including after inference.
 */
export function searchHybridMemoriesForQueries(
  index: SearchIndex,
  request: IndexedMemorySearchRequest,
  queries: readonly string[],
  prepared: MemoryQueryEmbeddingPreparation,
  ranking?: MemoryRanking,
): MemoryDocumentSearchMatch[] {
  const limit = request.limit ?? 10;
  const pages = queries.map((query, queryIndex) => {
    const vector = prepared.queryVectors?.[queryIndex];
    return searchHybridMemories(index, { ...request, query },
      { status: prepared.status, ...(vector ? { queryVector: vector } : {}) }, ranking).results;
  });
  const merged = new Map<string, MemoryDocumentSearchMatch>();
  for (let rank = 0; merged.size < limit && pages.some((page) => rank < page.length); rank += 1) {
    for (const page of pages) {
      const result = page[rank];
      if (result && !merged.has(result.id) && merged.size < limit) merged.set(result.id, result);
    }
  }
  return [...merged.values()];
}
