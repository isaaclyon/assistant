import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReloadSafeTelegramCommand } from "../lib/telegram-command.ts";
import { activeDebugTarget, debugEnabled, debugStatus, publishDebug, sensitiveDebugCall, setDebug, type DebugTarget } from "../../src/debug-messages.ts";

export default function debugExtension(pi: ExtensionAPI): void {
  const sensitive = new Set<string>();
  let turnTarget: DebugTarget | undefined;
  registerReloadSafeTelegramCommand({
    name: "debug", description: "Show tool activity and automatic memory recall: on, off, status",
    showInMenu: true, emoji: "🔎",
    handler: async (ctx) => {
      if (!ctx.target) { await ctx.reply("Debug is unavailable outside Telegram routing."); return; }
      const action = ctx.args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) { await ctx.reply("Usage: /debug [on|off|status]"); return; }
      if (action !== "status") setDebug(ctx.target, action === "" ? !debugEnabled(ctx.target) : action === "on");
      await ctx.reply(debugStatus(ctx.target));
    },
  });
  pi.on("tool_execution_start", (event) => {
    const hidden = sensitiveDebugCall(event.toolName, event.args);
    if (hidden) sensitive.add(event.toolCallId);
    publishDebug(`Tool call: ${event.toolName} (${event.toolCallId})`, hidden ? "[sensitive arguments omitted]" : event.args);
  });
  pi.on("tool_execution_end", (event) => {
    const hidden = sensitive.delete(event.toolCallId);
    publishDebug(`Tool ${event.isError ? "failed" : "result"}: ${event.toolName} (${event.toolCallId})`, hidden ? "[sensitive output omitted]" : event.result);
  });
  pi.on("agent_start", () => { turnTarget = activeDebugTarget(); publishDebug("Agent started", "Preparing a response."); });
  pi.on("agent_settled", () => { sensitive.clear(); if (turnTarget) publishDebug("Agent settled", "Response complete.", turnTarget); turnTarget = undefined; });
  pi.on("session_shutdown", () => { sensitive.clear(); turnTarget = undefined; });
}
