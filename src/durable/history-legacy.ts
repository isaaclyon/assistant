import { createReadStream } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface LegacyAnchor { sessionId: string; entryId: string; timestamp: string }
export type AnchorFinding =
  | 'SOURCE_SESSION_NOT_FOUND' | 'SOURCE_SESSION_INVALID' | 'SOURCE_ENTRY_NOT_FOUND'
  | 'SOURCE_TIMESTAMP_MISMATCH' | 'SOURCE_SESSION_SCAN_LIMIT_EXCEEDED';
export interface ScanBudget { bytes: number; entries: number; maxBytes: number; maxEntries: number }
export const DEFAULT_ANCHOR_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxEntries: 100_000 });

type SessionRead = { status: 'ok'; entries: Map<string, string> } | { status: 'invalid' } | { status: 'limit' };

async function readEntries(path: string, sessionId: string, wanted: ReadonlySet<string>, budget: ScanBudget): Promise<SessionRead> {
  const entries = new Map<string, string>();
  let header = false;
  let limited = false;
  const input = createReadStream(path);
  input.on('data', chunk => { budget.bytes += chunk.length; if (budget.bytes > budget.maxBytes) { limited = true; input.destroy(); } });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (limited) break;
      if (!line) continue;
      const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; timestamp?: unknown } | null;
      if (!header) {
        if (parsed?.type !== 'session' || parsed.id !== sessionId) { input.destroy(); return { status: 'invalid' }; }
        header = true;
      } else if (typeof parsed?.id === 'string' && typeof parsed?.timestamp === 'string') {
        if (++budget.entries > budget.maxEntries) { limited = true; input.destroy(); break; }
        if (!wanted.has(parsed.id)) continue;
        // A duplicate cited id makes the whole session ambiguous.
        if (entries.has(parsed.id)) { input.destroy(); return { status: 'invalid' }; }
        entries.set(parsed.id, parsed.timestamp);
      }
    }
  } catch { input.destroy(); return { status: limited ? 'limit' : 'invalid' }; }
  if (limited) return { status: 'limit' };
  return header ? { status: 'ok', entries } : { status: 'invalid' };
}

/**
 * Archived JSONL sessions are located by the `<timestamp>_<session-id>.jsonl` file name inside the configured roots only.
 * The checks and the shared scan budget follow ADR-0017, so old citations resolve exactly as before.
 */
export async function resolveLegacyAnchors(roots: readonly string[], anchors: readonly LegacyAnchor[], limits: { maxBytes: number; maxEntries: number } = DEFAULT_ANCHOR_LIMITS): Promise<Array<AnchorFinding | null>> {
  const requested = new Map<string, Set<string>>();
  for (const anchor of anchors) {
    if (!requested.has(anchor.sessionId)) requested.set(anchor.sessionId, new Set());
    requested.get(anchor.sessionId)!.add(anchor.entryId);
  }
  const sessions = new Map<string, SessionRead>();
  if (requested.size > 0) {
    const candidates = new Map([...requested.keys()].map(id => [id, [] as string[]]));
    for (const root of roots.map(path => resolve(path))) {
      try {
        if (!(await lstat(root)).isDirectory()) continue;
        for await (const entry of await opendir(root)) {
          if (!entry.name.endsWith('.jsonl')) continue;
          for (const id of requested.keys()) if (entry.name.endsWith(`_${id}.jsonl`)) candidates.get(id)!.push(join(root, entry.name));
        }
      } catch { continue; }
    }
    const budget: ScanBudget = { bytes: 0, entries: 0, ...limits };
    for (const [id, paths] of candidates) {
      let invalid = false;
      for (const path of paths.sort()) {
        const stat = await lstat(path).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink()) { invalid = true; continue; }
        const result = await readEntries(path, id, requested.get(id)!, budget);
        if (result.status === 'ok' || result.status === 'limit') { sessions.set(id, result); break; }
        invalid = true;
      }
      if (!sessions.has(id) && invalid) sessions.set(id, { status: 'invalid' });
      if (budget.bytes > limits.maxBytes || budget.entries > limits.maxEntries) break;
    }
    if (budget.bytes > limits.maxBytes || budget.entries > limits.maxEntries) {
      for (const id of requested.keys()) if (!sessions.has(id)) sessions.set(id, { status: 'limit' });
    }
  }
  return anchors.map(anchor => {
    const session = sessions.get(anchor.sessionId);
    if (!session) return 'SOURCE_SESSION_NOT_FOUND';
    if (session.status === 'limit') return 'SOURCE_SESSION_SCAN_LIMIT_EXCEEDED';
    if (session.status === 'invalid') return 'SOURCE_SESSION_INVALID';
    if (session.status !== 'ok' || !session.entries.has(anchor.entryId)) return 'SOURCE_ENTRY_NOT_FOUND';
    return session.entries.get(anchor.entryId) === anchor.timestamp ? null : 'SOURCE_TIMESTAMP_MISMATCH';
  });
}
