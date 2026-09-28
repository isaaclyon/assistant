import type { AgentSession } from "@earendil-works/pi-coding-agent";

const KEY = Symbol.for("pi-telegram-bridge.codex-fast");

/** Expose only fast-mode control, resolving the current session for every call. */
export function bindCodexFast(getSession: () => Pick<AgentSession, "extensionRunner">): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const control = async (action: string): Promise<string> => {
    if (!["on", "off", "status"].includes(action)) throw new Error("Invalid fast-mode action");
    if (!process.env.PI_CODEX_CONVERSION_CONFIG_PATH?.trim()) {
      return "Fast mode unavailable outside the assistant runtime.";
    }
    const runner = getSession().extensionRunner;
    const command = runner.getCommand("codex");
    if (!command) return "Codex fast-mode control is unavailable.";
    const ctx = runner.createCommandContext();
    const messages: string[] = [];
    let collecting = true;
    try {
      await command.handler(`fast ${action}`, {
        ...ctx,
        ui: { ...ctx.ui, notify: (message, type) => {
          if (collecting) messages.push(message);
          else ctx.ui.notify(message, type);
        } },
      });
    } finally {
      collecting = false;
    }
    return messages.join("\n") || "Codex fast-mode command completed without a status reply.";
  };
  store[KEY] = control;
  return () => { if (store[KEY] === control) delete store[KEY]; };
}
