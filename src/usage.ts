import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchCodexUsage } from "@howaboua/pi-codex-conversion/dist/codex-usage/client.js";
import { isCanonicalCodexSubscriptionModel } from "@howaboua/pi-codex-conversion/dist/adapter/prompt/codex-model.js";
import type { CodexUsageSnapshot, CodexUsageWindow } from "@howaboua/pi-codex-conversion/dist/codex-usage/payload.js";

const KEY = Symbol.for("pi-telegram-bridge.usage");
const UNAVAILABLE = "Usage is unavailable right now. Try /usage again shortly.";
type UsageModel = { id: string; name: string; provider: string };
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function timeRemaining(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}

function formatWindow(window: CodexUsageWindow, now: number): string[] {
  const minutes = window.windowMinutes;
  const label = minutes === 300 ? "5-hour" : minutes === 10_080 ? "Weekly" : minutes && minutes > 0 ? `${minutes}-minute` : "Window";
  const used = window.usedPercent;
  const remaining = used !== undefined && Number.isFinite(used) ? 100 - Math.min(100, Math.max(0, used)) : undefined;
  const lines = [remaining === undefined ? `${label}: usage unavailable` : `${label}: ${Math.round(remaining)}% remaining · ${Math.round(100 - remaining)}% used`];
  const resetMs = window.resetsAt === undefined ? NaN : window.resetsAt * 1000;
  const durationMs = minutes === undefined ? NaN : minutes * 60_000;
  const timeLeft = resetMs - now;
  if (Number.isFinite(resetMs) && Math.abs(resetMs) < 8.64e15) {
    lines.push(timeLeft > 0 ? `Resets in ${timeRemaining(timeLeft)} (${new Date(resetMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })})` : "Reset time has passed; refresh /usage.");
  }
  if (remaining !== undefined && Number.isFinite(durationMs) && durationMs > 0 && timeLeft > 0 && timeLeft <= durationMs) {
    const target = timeLeft / durationMs * 100;
    const difference = Math.round(remaining - target);
    const pace = difference === 0 ? "on pace" : `${Math.abs(difference)} percentage points ${difference > 0 ? "under" : "over"} pace`;
    lines.push(`Pace target: ${Math.round(target)}% remaining · ${pace}`);
  } else lines.push("Even pace unavailable for this window.");
  return lines;
}

/** Only render normalized allowance fields; the upstream raw payload stays private. */
export function formatUsage(model: UsageModel, snapshot: CodexUsageSnapshot, now = Date.now()): string {
  const lines = [`Usage · ${model.name} (${model.provider}/${model.id})`];
  const modelKey = normalize(model.id);
  const limits = snapshot.limits.filter((limit) => limit.limitId === "codex" || normalize(limit.limitId) === modelKey || (limit.limitName && normalize(limit.limitName) === modelKey));
  for (const limit of limits) {
    const windows = [limit.primary, limit.secondary].filter((value): value is CodexUsageWindow => Boolean(value));
    if (!windows.length) continue;
    lines.push("", limit.limitId === "codex" ? "Shared Codex allowance" : "Model allowance");
    for (const window of windows) lines.push(...formatWindow(window, now));
  }
  if (lines.length === 1) lines.push("No allowance data is available for the active model.");
  else lines.push("", "Pace assumes even use across each window. Shared allowance includes other Codex sessions.");
  return lines.join("\n");
}

/** A read-only host capability; resolve official context anew after model/session changes. */
export function bindUsage(
  getSession: () => Pick<AgentSession, "extensionRunner">,
  options: { fetchUsage?: (ctx: ExtensionContext) => Promise<CodexUsageSnapshot>; now?: () => number } = {},
): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const read = async (): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const ctx = getSession().extensionRunner.createCommandContext();
      const model = ctx.model;
      if (!model) return "No active model is selected.";
      if (!isCanonicalCodexSubscriptionModel(model)) return `Subscription allowance is unavailable for ${model.name} (${model.provider}).`;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Usage timeout")); }, 10_000);
      });
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const snapshot = await Promise.race([(options.fetchUsage ?? fetchCodexUsage)({ ...ctx, signal }), timeout]);
      const currentModel = getSession().extensionRunner.createCommandContext().model;
      if (currentModel?.id !== model.id || currentModel.provider !== model.provider) return "The active model changed while checking usage. Run /usage again.";
      return formatUsage(model, snapshot, (options.now ?? Date.now)());
    } catch {
      return UNAVAILABLE;
    } finally { if (timer) clearTimeout(timer); }
  };
  store[KEY] = read;
  return () => { if (store[KEY] === read) delete store[KEY]; };
}
