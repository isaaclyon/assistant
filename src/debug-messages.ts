export interface DebugTarget { chatId: number; threadId?: number }
export interface DebugTransport {
  getActiveTarget(): DebugTarget | undefined;
  send(target: DebugTarget, text: string): Promise<unknown>;
}
interface DebugState { pending: number; dropped: number; failed: number; tail: Promise<void> }
const STATE = Symbol.for("pi-telegram-bridge.debug-state");
const TRANSPORT = Symbol.for("pi-telegram-bridge.debug-transport");
const key = (target: DebugTarget) => `${target.chatId}:${target.threadId ?? 0}`;
function states(): Map<string, DebugState> {
  const store = globalThis as Record<PropertyKey, unknown>;
  return (store[STATE] ??= new Map<string, DebugState>()) as Map<string, DebugState>;
}
function transport(): DebugTransport | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[TRANSPORT] as DebugTransport | undefined;
}
export function setDebug(target: DebugTarget, enabled: boolean): void {
  if (!enabled) states().delete(key(target));
  else if (!states().has(key(target))) states().set(key(target), { pending: 0, dropped: 0, failed: 0, tail: Promise.resolve() });
}
export function debugStatus(target: DebugTarget): string {
  const state = states().get(key(target));
  return state ? `Debug on for this chat/thread until the bridge restarts. ${state.failed} failed sends; ${state.dropped} messages dropped.` : "Debug off for this chat/thread.";
}
export function debugEnabled(target: DebugTarget): boolean { return states().has(key(target)); }
export function activeDebugTarget(): DebugTarget | undefined {
  const target = transport()?.getActiveTarget();
  return target ? { ...target } : undefined;
}

/** Common credential formats are scrubbed before truncation. Never deliver images or binary data. */
export function debugText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, (name, item: unknown) => {
      if (/password|passwd|secret|token|authorization|cookie|api[_-]?key|credential|^code$|^otp$/i.test(name)) return "[redacted]";
      if (name === "data" || name === "base64") return "[binary omitted]";
      return item;
    }, 2) ?? "";
  } catch { text = "[unavailable]"; }
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "[redacted authorization]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|\d{6,}:[A-Za-z0-9_-]{25,})\b/g, "[redacted token]")
    .replace(/((?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@")
    .replace(/<!--[\s\S]*?-->/g, "[markup omitted]");
  if (text.length > 3400) {
    text = text.slice(0, 3370).replace(/[\uD800-\uDBFF]$/, "") + "\n[truncated]";
  }
  return text;
}

/** Notification only: ordered, bounded, and fail-open; never waits on Telegram in a tool hook. */
export function publishDebug(label: string, value: unknown, destination?: DebugTarget): void {
  try {
    const sender = transport();
    const active = destination ?? sender?.getActiveTarget();
    if (!sender || !active) return;
    const target = { ...active };
    const targetKey = key(target);
    const state = states().get(targetKey);
    if (!state) return;
    if (state.pending >= 128) { state.dropped++; return; }
    const text = debugText(`🔎 ${label}\n${debugText(value)}`);
    state.pending++;
    state.tail = state.tail.then(async () => {
      if (states().get(targetKey) !== state) return;
      try { await sender.send(target, text); } catch { state.failed++; }
    }).finally(() => { state.pending--; });
  } catch { /* Diagnostics must never change agent execution. */ }
}

export function sensitiveDebugCall(toolName: string, input: unknown): boolean {
  if (/^private_|^browser_takeover$/.test(toolName)) return true;
  let text = "";
  try { text = JSON.stringify(input); } catch { return true; }
  return /telegram\.json|credentials?\.json|auth\.json|\.env\b|\/onepassword\/|\bop\s+(?:read|item|get)|printenv|\benv\b|password|secret|api[_-]?key|access[_-]?token|browser.*(?:profile|runtime)/i.test(text);
}
