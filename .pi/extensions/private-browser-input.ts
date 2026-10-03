import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadBridgeInstanceConfig } from "../../src/config.ts";
import { runPrivateBrowserInput } from "../../src/private-browser-input.ts";
import { openTableRequest } from "../../src/opentable-private-flow.ts";
import type { ProtectedInputRequest } from "../../src/protected-browser.ts";

export default function privateBrowserInput(pi: ExtensionAPI) {
  let active: AbortController | undefined;
  let settling: Promise<unknown> | undefined;
  pi.on("session_shutdown", async () => { active?.abort(); await settling?.catch(() => {}); });
  pi.on("tool_call", () => active ? { block: true, reason: "Private browser input is active. Wait for its result." } : undefined);
  async function execute(request: ProtectedInputRequest, signal: AbortSignal | undefined, notifyWaiting: () => void) {
    if (active) throw new Error("Private input is already active");
    const controller = new AbortController(); active = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let details: { status: string };
    try {
      const registry = (globalThis as any)[Symbol.for("pi-telegram-bridge.target-scope-registry")];
      const target = registry?.provider?.getActiveTarget();
      if (!target) throw new Error();
      const work = runPrivateBrowserInput({ config: await loadBridgeInstanceConfig(), request,
        chatId: target.chatId, ...(target.threadId ? { threadId: target.threadId } : {}), signal: controller.signal, notifyWaiting });
      settling = work;
      details = await work;
    } catch { details = { status: "unavailable" }; }
    finally { signal?.removeEventListener("abort", abort); settling = undefined; if (active === controller) active = undefined; }
    return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
  }
  pi.registerTool(defineTool({
    name: "private_browser_input",
    label: "Private browser input",
    description: "Open an authenticated Telegram form to fill and submit a supported website sign-in form. Values bypass model context. Waits for the user, then resumes this turn. Requires a private Telegram chat, one stock-Chrome tab, HTTPS, and a same-origin POST form. Closes the sensitive tab and opens resumeUrl afterward; verify sign-in separately.",
    promptGuidelines: [
      "Use only for user-authorized sign-in or verification, never purchases, account changes, or payments. Never ask for values in chat or tool parameters.",
      "Inspect the form first. Provide CSS selectors, exact pageUrl and a same-origin resumeUrl without query/fragment. Tell the user you will wait while they fill the Telegram form.",
      "Do not run parallel browser work, bypass the stock-Chrome gate, inspect browser runtime/profile files, or call raw CDP. If browser_blocked, stop that browser with the stock helper before reopening it.",
      "The generic private_browser_input supports ordinary same-origin POST forms. Use private_opentable_login for OpenTable's embedded email login. Other unsupported forms, frames, CAPTCHA, or passkeys need SSH handoff.",
    ],
    parameters: Type.Object({
      session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }),
      pageUrl: Type.String({ maxLength: 2000 }), resumeUrl: Type.String({ maxLength: 2000 }),
      fields: Type.Array(Type.Object({ kind: StringEnum(["username", "password", "code"] as const), selector: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
      submitSelector: Type.String({ minLength: 1, maxLength: 300 }),
    }, { additionalProperties: false }),
    async execute(_id, request, signal, update) {
      return execute(request, signal, () => update?.({ content: [{ type: "text", text: "Secure form sent. Waiting for private input." }], details: undefined }));
    },
  }));
  pi.registerTool(defineTool({
    name: "private_opentable_login",
    label: "Private OpenTable sign-in",
    description: "Sign in to an existing OpenTable account through a private Telegram form. Handles email, then password or a six-digit code inside the embedded sign-in page. Keeps the browser protected across steps and returns only a terminal status. Requires one stock-Chrome tab at https://www.opentable.com/ with Sign in open and Use email instead selected. Verify login afterward on the clean homepage.",
    promptGuidelines: [
      "Use private_opentable_login for user-authorized OpenTable sign-in. Open its homepage, click Sign in, and select Use email instead before calling. Do not ask for email, password or code in chat.",
      "Tell the user to keep Tailscale connected and fill the Telegram form; it asks for each step while you wait. Do not inspect the browser during entry. Registration, account changes, CAPTCHA and unexpected steps stop the flow and need manual handoff.",
      "In Gmail-enabled profiles, a fresh matching email code can be retrieved and filled privately when the receiving address matches the configured default inbox. Uncertain or unavailable lookup leaves manual input. Do not read an email thread into model context just to retrieve a code for this flow.",
    ],
    parameters: Type.Object({ session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }) }, { additionalProperties: false }),
    async execute(_id, request, signal, update) {
      return execute(openTableRequest(request.session), signal, () => update?.({ content: [{ type: "text", text: "Secure form sent. Waiting for private input." }], details: undefined }));
    },
  }));
}
