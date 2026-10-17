/** Pure native Telegram UI helpers: command parsing, callback data, menus, diagnostics.
 * No I/O. Callback data never carries model-supplied or credential material. */
export type Button = { text: string; callback: string } | { text: string; url: string };
export type Buttons = Button[][];
export type Presentation = { text: string; buttons?: Buttons };
export type ReplyMarkup = { inline_keyboard: ({ text: string; callback_data: string } | { text: string; url: string })[][] };

export const MESSAGE_LIMIT = 4096;
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const ID = /^[A-Za-z0-9._:/@+-]{1,48}$/;
const KEY = /^[A-Za-z0-9_-]{8,56}$/;

/** Slash commands. Controls go through durable host controls; the rest through the UI controller. */
export const CONTROL_COMMANDS = ['new', 'abort', 'stop', 'compact'] as const;
export const UI_COMMANDS = ['menu', 'model', 'thinking', 'skills', 'debug', 'reload', 'restart'] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
export type UiCommandName = (typeof UI_COMMANDS)[number];
export type ParsedText =
  | { type: 'text' }
  | { type: 'control'; name: ControlCommand }
  | { type: 'ui'; name: UiCommandName }
  | { type: 'unavailable'; command: string; reason: 'unknown' | 'arguments' | 'disabled' };
const COMMAND = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@[A-Za-z0-9_]{3,64})?(?:\s+([\s\S]*))?$/;
/** Unknown or argument-bearing slash commands are never forwarded to the model. */
export function parseCommandText(text: string, enabled?: ReadonlySet<string>): ParsedText {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { type: 'text' };
  const match = COMMAND.exec(trimmed);
  if (!match) return { type: 'unavailable', command: '', reason: 'unknown' };
  const command = match[1]!.toLowerCase();
  const alias = command === 'start' || command === 'status' ? 'menu' : command;
  const known = (CONTROL_COMMANDS as readonly string[]).includes(alias) || (UI_COMMANDS as readonly string[]).includes(alias);
  if (!known) return { type: 'unavailable', command: alias, reason: 'unknown' };
  if (match[2]?.trim()) return { type: 'unavailable', command: alias, reason: 'arguments' };
  if (enabled && !enabled.has(alias)) return { type: 'unavailable', command: alias, reason: 'disabled' };
  return (CONTROL_COMMANDS as readonly string[]).includes(alias) ? { type: 'control', name: alias as ControlCommand } : { type: 'ui', name: alias as UiCommandName };
}

/** Callback data grammar (all <= 64 bytes):
 *  m:<menu|model|thinking|skills> · mp:<page> · mc:<model id> · tl:<level>
 *  k:<new|compact|abort|stop> (durable controls) · cf:<a|d>:<confirmation key> */
export type CallbackAction =
  | { type: 'menu'; name: 'menu' | 'model' | 'thinking' | 'skills' }
  | { type: 'modelPage'; page: number }
  | { type: 'model'; id: string }
  | { type: 'thinking'; level: ThinkingLevel }
  | { type: 'control'; name: ControlCommand }
  | { type: 'confirmation'; key: string; choice: 'approve' | 'deny' };
export function parseCallbackData(data: unknown): CallbackAction | undefined {
  if (typeof data !== 'string' || bytes(data) > 64) return undefined;
  const [kind, ...rest] = data.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'm': return (['menu', 'model', 'thinking', 'skills'] as const).includes(arg as 'menu') ? { type: 'menu', name: arg as 'menu' } : undefined;
    case 'mp': return /^\d{1,3}$/.test(arg) ? { type: 'modelPage', page: Number(arg) } : undefined;
    case 'mc': return ID.test(arg) ? { type: 'model', id: arg } : undefined;
    case 'tl': return (THINKING_LEVELS as readonly string[]).includes(arg) ? { type: 'thinking', level: arg as ThinkingLevel } : undefined;
    case 'k': return (CONTROL_COMMANDS as readonly string[]).includes(arg) ? { type: 'control', name: arg as ControlCommand } : undefined;
    case 'cf': {
      const [choice, key, ...extra] = rest;
      return extra.length === 0 && (choice === 'a' || choice === 'd') && key !== undefined && KEY.test(key) ? { type: 'confirmation', key, choice: choice === 'a' ? 'approve' : 'deny' } : undefined;
    }
    default: return undefined;
  }
}

/** Approve/deny presentation for a durable memory confirmation. `key` is an opaque
 * <=56 character handle the controller resolves; it is not the approval secret. */
export function confirmationPresentation(key: string, text: string): Presentation {
  if (!KEY.test(key)) throw new Error('Invalid confirmation key');
  return { text, buttons: [[{ text: 'Approve', callback: `cf:a:${key}` }, { text: 'Deny', callback: `cf:d:${key}` }]] };
}

export function clean(value: string, max = MESSAGE_LIMIT): string {
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function toReplyMarkup(buttons: Buttons | undefined): ReplyMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  if (buttons.length > 12) throw new Error('Too many button rows');
  return { inline_keyboard: buttons.map(row => {
    if (row.length === 0 || row.length > 4) throw new Error('Invalid button row');
    return row.map(button => {
      const text = clean(button.text, 64);
      if (!text.trim()) throw new Error('Empty button text');
      if ('callback' in button) {
        if (bytes(button.callback) > 64 || parseCallbackData(button.callback) === undefined) throw new Error('Invalid callback data');
        return { text, callback_data: button.callback };
      }
      let url: URL;
      try { url = new URL(button.url); } catch { throw new Error('Invalid button URL'); }
      if (url.protocol !== 'https:' || button.url.length > 512 || url.username || url.password) throw new Error('Invalid button URL');
      return { text, url: url.toString() };
    });
  }) };
}
export function assertPresentation(value: Presentation): Presentation {
  const text = clean(value.text);
  if (!text.trim()) throw new Error('Empty presentation');
  toReplyMarkup(value.buttons);
  return { text, ...(value.buttons ? { buttons: value.buttons } : {}) };
}

// ---- Menus -------------------------------------------------------------
export type MenuState = { model?: string; thinking?: string; busy?: boolean };
export const statusMenu = (state: MenuState): Presentation => ({
  text: clean(['Assistant', `Model: ${clean(state.model ?? 'unknown', 80)}`, `Thinking: ${clean(state.thinking ?? 'unknown', 20)}`, state.busy ? 'Status: working' : 'Status: idle'].join('\n')),
  buttons: [
    [{ text: 'Model', callback: 'm:model' }, { text: 'Thinking', callback: 'm:thinking' }],
    [{ text: 'New', callback: 'k:new' }, { text: 'Compact', callback: 'k:compact' }],
    [{ text: 'Skills', callback: 'm:skills' }, ...(state.busy ? [{ text: 'Abort', callback: 'k:abort' }] : [])],
  ],
});
export type ModelChoice = { id: string; label: string };
export const MODEL_PAGE_SIZE = 6;
export function modelMenu(choices: readonly ModelChoice[], current: string | undefined, page: number): Presentation {
  const pages = Math.max(1, Math.ceil(choices.length / MODEL_PAGE_SIZE));
  const at = Math.min(Math.max(0, Math.trunc(page)), pages - 1);
  const rows: Buttons = choices.slice(at * MODEL_PAGE_SIZE, (at + 1) * MODEL_PAGE_SIZE).filter(c => ID.test(c.id)).map(c => [{ text: `${c.id === current ? '✓ ' : ''}${clean(c.label, 56)}`, callback: `mc:${c.id}` }]);
  const nav: Button[] = [];
  if (at > 0) nav.push({ text: 'Prev', callback: `mp:${at - 1}` });
  if (at < pages - 1) nav.push({ text: 'Next', callback: `mp:${at + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: 'Back', callback: 'm:menu' }]);
  return { text: `Choose a model (page ${at + 1}/${pages})`, buttons: rows };
}
export function thinkingMenu(levels: readonly string[], current: string | undefined): Presentation {
  const allowed = THINKING_LEVELS.filter(level => levels.includes(level));
  const rows: Buttons = [];
  for (let i = 0; i < allowed.length; i += 3) rows.push(allowed.slice(i, i + 3).map(level => ({ text: `${level === current ? '✓ ' : ''}${level}`, callback: `tl:${level}` })));
  rows.push([{ text: 'Back', callback: 'm:menu' }]);
  return { text: 'Choose a thinking level', buttons: rows };
}
export function skillsList(skills: readonly { name: string; description?: string }[]): Presentation {
  const lines = skills.slice(0, 40).map(s => `• ${clean(s.name, 60)}${s.description ? `: ${clean(s.description, 120)}` : ''}`);
  if (skills.length > 40) lines.push(`…and ${skills.length - 40} more`);
  return { text: clean(lines.length ? `Skills\n${lines.join('\n')}` : 'No skills are selected.'), buttons: [[{ text: 'Back', callback: 'm:menu' }]] };
}

// ---- Diagnostics -------------------------------------------------------
const SECRET_KEY = '(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[A-Za-z0-9_-]*)';
const REDACTIONS: [RegExp, string][] = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[bot-token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [new RegExp(`(\\b${SECRET_KEY}\\b["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  [/\b(?:sk|pk|ghp|gho|ghs|xox[a-z]|AKIA|op)[-_A-Za-z0-9]{16,}\b/g, '[secret]'],
  [/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?[redacted]'],
  [/\/(?:Users|home)\/[^/\s]+/g, '~'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[hex]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[opaque]'],
];
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}
export type DiagnosticSection = { title: string; lines: readonly string[] };
export const DIAGNOSTIC_LIMITS = { sections: 8, lines: 20, line: 300, total: 3500 } as const;
/** Redacted, bounded text for the originating private target only. */
export function formatDiagnostics(sections: readonly DiagnosticSection[]): Presentation {
  const out: string[] = ['Debug'];
  for (const section of sections.slice(0, DIAGNOSTIC_LIMITS.sections)) {
    out.push('', clean(redact(section.title), 60));
    for (const line of section.lines.slice(0, DIAGNOSTIC_LIMITS.lines)) out.push(`  ${clean(redact(line), DIAGNOSTIC_LIMITS.line)}`);
    if (section.lines.length > DIAGNOSTIC_LIMITS.lines) out.push(`  …${section.lines.length - DIAGNOSTIC_LIMITS.lines} more`);
  }
  if (sections.length > DIAGNOSTIC_LIMITS.sections) out.push('', `…${sections.length - DIAGNOSTIC_LIMITS.sections} more sections`);
  return { text: clean(out.join('\n'), DIAGNOSTIC_LIMITS.total) };
}
export const unavailableText = (item: Extract<ParsedText, { type: 'unavailable' }>): string =>
  item.reason === 'arguments' ? `/${item.command} takes no arguments.`
    : item.reason === 'disabled' ? `/${item.command} is unavailable on this instance.`
      : 'Unknown command. Available: /new /abort /stop /compact /model /thinking /skills /debug /reload /restart /menu.';
