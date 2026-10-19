/** Transient "Working…" tool-activity message for the native Telegram surface.
 * Labels keep the friendly legacy wording and never include raw output,
 * credentials, patch bodies, search text or unrecognized commands. The message
 * is best effort: failures only stop the display and never reach durable state. */
import type { Target } from './ingress.js';

export const TOOL_ACTIVITY_EDIT_INTERVAL_MS = 1_000;
const MAX_LINES = 6, MAX_ENTRIES = 32, HINT_MAX = 64;

/** Narrow output port. The bridge binds it to one authorized private target. */
export interface ToolActivityPort {
  send(target: Target, text: string): Promise<number | undefined>;
  edit(target: Target, messageId: number, text: string): Promise<unknown>;
  remove(target: Target, messageId: number): Promise<unknown>;
}

const compact = (value: string) => {
  const flat = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return flat.length <= HINT_MAX ? flat : `${flat.slice(0, HINT_MAX - 1)}…`;
};
const relative = (value: string, cwd?: string) => {
  if (!cwd) return value;
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
};
const str = (args: unknown, key: string): string | undefined => {
  if (typeof args !== 'object' || args === null) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v : undefined;
};
const pathHint = (value: string | undefined, cwd?: string) =>
  value === undefined || value === cwd ? undefined : compact(relative(value, cwd));

function patchLabel(args: unknown, cwd?: string): string {
  const patch = str(args, 'input');
  if (patch === undefined) return 'Edited files';
  const paths = new Set(Array.from(patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm), m => m[1]!.trim()));
  if (paths.size > 1) return `Edited ${paths.size} files`;
  if (paths.size === 0) return 'Edited files';
  const path = pathHint(paths.values().next().value, cwd);
  return path === undefined ? 'Edited file' : `Edited ${path}`;
}

function commandLabel(command: string): string {
  if (/\bgit\s+status\b/.test(command)) return 'Checked Git status';
  if (/\bgit\s+diff\b/.test(command)) return 'Reviewed changes';
  if (/\bgit\s+(?:log|show|rev-parse)\b/.test(command)) return 'Inspected Git history';
  if (/\b(?:npm|pnpm|yarn)\s+run\s+check\b/.test(command)) return 'Ran project checks';
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(command) || /\b(?:vitest|pytest)\b/.test(command)) return 'Ran tests';
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/.test(command)) return 'Built the project';
  if (/(?:^|[;&|\n]\s*)\s*(?:rg|grep|find)\b/m.test(command)) return 'Searched files';
  if (/(?:^|[;&|\n]\s*)\s*(?:cat|sed|head|tail)\b/m.test(command)) return 'Read files';
  if (/(?:^|[;&|\n]\s*)\s*ls\b/m.test(command)) return 'Listed files';
  return 'Ran command';
}

export function toolActivityLabel(toolName: unknown, args: unknown, cwd?: string): string {
  const name = typeof toolName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(toolName) ? toolName : 'tool';
  const path = pathHint(str(args, 'path') ?? str(args, 'file_path') ?? str(args, 'filePath'), cwd);
  if (name === 'read' || name === 'read_symbol' || name === 'read_enclosing') return path === undefined ? 'Read file' : `Read ${path}`;
  if (name === 'ls') return path === undefined ? 'Listed files' : `Listed ${path}`;
  if (name === 'grep' || name === 'find' || name === 'symbol_search') return path === undefined ? 'Searched files' : `Searched ${path}`;
  if (name === 'apply_patch') return patchLabel(args, cwd);
  if (name === 'web_search' || name === 'web_run') return 'Searched the web';
  if (name === 'fetch_content' || name === 'get_search_content') return 'Read web content';
  if (name === 'write_stdin') return 'Waited for command';
  if (name === 'process') return 'Managed background process';
  if (name === 'Agent' || name === 'subagent') return 'Delegated work';
  if (name === 'lsp_diagnostics' || name === 'lens_diagnostics') return 'Checked code';
  if (name === 'exec_command' || name === 'bash') {
    const command = str(args, 'cmd') ?? str(args, 'command');
    return command === undefined ? 'Ran command' : commandLabel(command);
  }
  return name;
}

const elapsedText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

type Entry = { id: string; label: string; status: 'running' | 'done' | 'error' };
interface State { entries: Entry[]; count: number; startedAt: number; messageId?: number; sent: string; lastFlush?: number; finished: boolean; flushing?: Promise<void> | undefined; again?: boolean; timer?: unknown }

export interface ToolActivityOptions {
  port: ToolActivityPort;
  target: Target;
  cwd?: string;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function buildToolActivityText(entries: readonly Entry[], count: number, elapsedMs: number): string {
  const lines = ['🛠 Working…'];
  for (const e of entries.slice(-MAX_LINES)) lines.push(`${e.status === 'running' ? '⏳' : e.status === 'error' ? '✗' : '▸'} ${e.label}`);
  lines.push(`(${count} ${count === 1 ? 'tool' : 'tools'} · ${elapsedText(elapsedMs)})`);
  return lines.join('\n');
}

export function createToolActivity(options: ToolActivityOptions) {
  const now = options.now ?? Date.now, interval = options.intervalMs ?? TOOL_ACTIVITY_EDIT_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = options.clearTimer ?? ((t: unknown) => clearTimeout(t as never));
  let state: State | undefined;
  const target = () => ({ ...options.target });

  const flush = (cur: State): Promise<void> => {
    if (cur.finished) return Promise.resolve();
    if (cur.flushing) { cur.again = true; return cur.flushing; }
    cur.flushing = (async () => {
      cur.again = false;
      const text = buildToolActivityText(cur.entries, cur.count, now() - cur.startedAt);
      try {
        if (cur.messageId === undefined) {
          const id = await options.port.send(target(), text);
          if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new Error('missing receipt');
          cur.messageId = id as number; cur.sent = text;
        } else if (text !== cur.sent) {
          await options.port.edit(target(), cur.messageId, text); cur.sent = text;
        }
        cur.lastFlush = now();
      } catch { cur.finished = true; } // Display only: stop on the first failure.
    })();
    const settle = () => { cur.flushing = undefined; if (state === cur && !cur.finished && cur.again) { cur.again = false; schedule(cur); } };
    return cur.flushing.then(settle, settle);
  };
  const schedule = (cur: State) => {
    if (cur.finished) return;
    if (cur.flushing) { cur.again = true; return; }
    const wait = cur.lastFlush === undefined ? 0 : cur.lastFlush + interval - now();
    if (wait <= 0) { void flush(cur); return; }
    if (cur.timer !== undefined) return;
    cur.timer = setTimer(() => { cur.timer = undefined; if (state === cur && !cur.finished) void flush(cur); }, wait);
  };
  const cancel = (cur: State) => { if (cur.timer !== undefined) { clearTimer(cur.timer); cur.timer = undefined; } };

  return {
    start(id: string, toolName: unknown, args: unknown): void {
      if (!state) state = { entries: [], count: 0, startedAt: now(), sent: '', finished: false };
      if (state.finished) return;
      state.entries.push({ id, label: toolActivityLabel(toolName, args, options.cwd), status: 'running' });
      if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
      state.count += 1; schedule(state);
    },
    end(id: string, isError: boolean): void {
      if (!state || state.finished) return;
      for (let i = state.entries.length - 1; i >= 0; i--) {
        const e = state.entries[i]!;
        if (e.id !== id) continue;
        e.status = isError ? 'error' : 'done'; schedule(state); return;
      }
    },
    /** Cancels pending edits and removes the message. Safe to call repeatedly. */
    async finish(): Promise<void> {
      const cur = state; state = undefined;
      if (!cur) return;
      cancel(cur); cur.finished = true;
      await cur.flushing?.catch(() => undefined);
      if (cur.messageId !== undefined) await options.port.remove(target(), cur.messageId).catch(() => undefined);
    },
  };
}
export type ToolActivity = ReturnType<typeof createToolActivity>;
