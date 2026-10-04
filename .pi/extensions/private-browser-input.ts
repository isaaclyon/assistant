import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadBridgeInstanceConfig } from "../../src/config.ts";
import { runPrivateBrowserInput } from "../../src/private-browser-input.ts";
import { openTableRequest } from "../../src/opentable-private-flow.ts";
import type { ProtectedInputRequest } from "../../src/protected-browser.ts";
import { runBrowserTakeover } from "../../src/browser-takeover.ts";
import type { TakeoverRequest } from "../../src/browser-takeover-protection.ts";
import type { PrivateLoginRequest } from "../../src/private-login.ts";

export default function privateBrowserInput(pi: ExtensionAPI) {
  let active: AbortController | undefined;
  let settling: Promise<unknown> | undefined;
  pi.on("session_shutdown", async () => { active?.abort(); await settling?.catch(() => {}); });
  pi.on("tool_call", () => active ? { block: true, reason: "Private browser input is active. Wait for its result." } : undefined);
  async function execute(request: ProtectedInputRequest | TakeoverRequest | PrivateLoginRequest, signal: AbortSignal | undefined, notifyWaiting: () => void) {
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
      const common = { config: await loadBridgeInstanceConfig(), chatId: target.chatId,
        ...(target.threadId ? { threadId: target.threadId } : {}), signal: controller.signal, notifyWaiting };
      const work = "fields" in request ? runPrivateBrowserInput({ ...common, request }) : runBrowserTakeover({ ...common, request, ...("pageUrl" in request ? { login: request } : {}) });
      settling = work;
      details = await work;
    } catch { details = { status: "unavailable" }; }
    finally { signal?.removeEventListener("abort", abort); settling = undefined; if (active === controller) active = undefined; }
    return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
  }
  pi.registerTool(defineTool({
    name: "private_browser_login", label: "Private sign-in",
    description: "Private multi-step existing-account sign-in in stock Chrome. Recognizes common same-origin POST email/username, password and verification-code screens, retaining the protected browser across steps. The Mini App can switch directly to human takeover for unfamiliar screens. Returns only a fixed terminal status and reopens the clean resume URL unless the user explicitly shares a page.",
    promptGuidelines: [
      "Use private_browser_login for authorized existing-account sign-in across multiple screens. Inspect the initial page first; pass its exact pageUrl and a clean same-origin HTTPS resumeUrl. Tell the user to keep Tailscale connected and open Sign in privately.",
      "Never ask for credentials in chat or tool arguments. Optional credentialItem names a user-approved Login item in the current instance's dedicated 1Password vault; the user may select Use saved sign-in privately. No general email-code lookup is enabled; codes remain private manual input.",
      "Stay paused for the whole operation. Do not inspect browser/runtime/profile files, use raw CDP, or run other browser tools while waiting. Unknown, repeated, embedded, cross-origin, recovery, registration or CAPTCHA screens need the Take over choice inside the Mini App; it preserves the same protected session.",
      "submitted is not proof of authentication. Verify the clean resume page afterward. Continue from this page explicitly shares the current website/form contents. On browser_blocked stop the stock session before reopening; never delete the gate.",
    ],
    parameters: Type.Object({ session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }), pageUrl: Type.String({ maxLength: 2000 }), resumeUrl: Type.String({ maxLength: 2000 }), credentialItem: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
    async execute(_id, request, signal, update) {
      return execute(request, signal, () => update?.({ content: [{ type: "text", text: "Private sign-in opened. Waiting for sign-in or handback." }], details: undefined }));
    },
  }));
  pi.registerTool(defineTool({
    name: "browser_takeover", label: "Browser takeover",
    description: "Let the paired user control a live stock-Chrome window inside a private Telegram Mini App. Pauses agent browser access until Hand back, cancellation or expiry. Requires one HTTPS tab and a clean same-origin resume URL. Only a fixed status returns; never browser images, keys or credentials.",
    promptGuidelines: [
      "Use browser_takeover for an authorized human-only browser step or when the user requests control. Tell them to keep Tailscale connected, tap Take over, and tap Hand back when finished. Wait for the tool result; do not run other tools or inspect the protected browser/runtime/profile.",
      "Provide a clean HTTPS resumeUrl on the current site's origin without query or fragment. Return privately reopens it and discards tabs/unsaved page state while retaining cookies. Continue from this page is an explicit user choice that shares the visible website, including form contents; it preserves in-page state. Verify the resulting page afterward.",
      "The human makes any consequential changes directly. A takeover does not authorize the assistant to make additional purchases, account changes or payments. Passkeys still need a compatible authenticator in that browser; takeover alone does not install or unlock 1Password.",
      "If browser_blocked is returned, stop that session with the stock helper before reopening. Never delete the crash gate or bypass it with raw CDP. On cancelled or expired results, private cleanup reopens resumeUrl; do not infer that the user's task succeeded.",
    ],
    parameters: Type.Object({ session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }), resumeUrl: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
    async execute(_id, request, signal, update) {
      return execute(request, signal, () => update?.({ content: [{ type: "text", text: "Takeover sent. Waiting for the user to hand back the browser." }], details: undefined }));
    },
  }));
  pi.registerTool(defineTool({
    name: "private_browser_input",
    label: "Private browser input",
    description: "Open an authenticated Telegram form to fill and submit a supported website sign-in form. Values bypass model context. Waits for the user, then resumes this turn. Requires a private Telegram chat, one stock-Chrome tab, HTTPS, and a same-origin POST form. Closes the sensitive tab and opens resumeUrl afterward; verify sign-in separately.",
    promptGuidelines: [
      "Use only for user-authorized sign-in or verification, never purchases, account changes, or payments. Never ask for values in chat or tool parameters.",
      "Inspect the form first. Provide CSS selectors, exact pageUrl and a same-origin resumeUrl without query/fragment. Tell the user you will wait while they fill the Telegram form.",
      "Do not run parallel browser work, bypass the stock-Chrome gate, inspect browser runtime/profile files, or call raw CDP. If browser_blocked, stop that browser with the stock helper before reopening it.",
      "The generic private_browser_input supports ordinary same-origin POST forms. Use private_opentable_login for OpenTable's embedded email login. Use browser_takeover for authorized manual steps in other forms, frames or CAPTCHA; passkeys still require a compatible authenticator in that browser. SSH handoff remains a fallback.",
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
