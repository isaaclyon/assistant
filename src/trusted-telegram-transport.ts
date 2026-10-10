import { authorizeRuntimeTelegramCall, CREDENTIAL_CALLBACK_PREFIX } from "./trusted-telegram-policy.js";
import { TrustedTelegramStore, type CredentialApprovalDetails } from "./trusted-telegram-store.js";
import { validateMiniAppIdentity } from "./secure-input-demo.js";

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const denied = () => json({ ok: false, error_code: 403, description: "Trusted transport denied this request" }, 403);

/** Only this process receives the real token. The runtime-facing server supplies
 * already-bounded requests over its private socket. No caller controls an
 * upstream host, token, polling offset, or trusted message identity. */
export class TrustedTelegramTransport {
  private polling = false;
  constructor(private readonly token: string, private readonly store: TrustedTelegramStore,
    private readonly upstream: typeof fetch = fetch) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid trusted Telegram configuration");
  }

  private async request(method: string, body: Json | FormData): Promise<Response> {
    try {
      const response = await this.upstream(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(35_000),
        ...(body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      // Discard upstream headers and errors, which are outside our public schema.
      const result: unknown = await response.json();
      if (!record(result) || result.ok !== true) return json({ ok: false, error_code: 502, description: "Telegram request unavailable" }, 502);
      return json({ ok: true, result: result.result });
    } catch { return json({ ok: false, error_code: 502, description: "Telegram request unavailable" }, 502); }
  }

  /** One bounded long poll. The supervisor repeats with backoff on failure.
   * Persist the entire batch before sending the next Telegram offset. */
  async pollOnce(now: () => number = Date.now): Promise<void> {
    if (this.polling) throw new Error("Trusted Telegram poll already active");
    this.polling = true;
    try {
      const response = await this.request("getUpdates", { offset: this.store.pollOffset, timeout: 25,
        allowed_updates: ["message", "edited_message", "callback_query"] });
      const payload: unknown = await response.json();
      if (!record(payload) || payload.ok !== true || !Array.isArray(payload.result)) throw new Error("Trusted Telegram polling unavailable");
      const callbacks = this.store.ingest(payload.result, now());
      await Promise.all(callbacks.map(id => this.request("answerCallbackQuery", { callback_query_id: id, text: "Decision received" })));
    } finally { this.polling = false; }
  }

  async initialize(): Promise<void> {
    const response = await this.request("deleteWebhook", { drop_pending_updates: false });
    if (!response.ok) throw new Error("Trusted Telegram initialization unavailable");
  }

  async showApproval(details: CredentialApprovalDetails, now = Date.now()): Promise<string> {
    const approval = this.store.createApproval(details, now);
    const response = await this.request("sendMessage", {
      chat_id: this.store.userId,
      text: [`Credential request from ${details.instance}`, `Login: ${details.title} (${details.username})`,
        `Source vault: ${details.vaultName}`, `Website: ${details.origin}`, `Purpose: ${details.purpose}`,
        "Allow Once uses this login for one sign-in. Always Allow saves an independent copy for future sign-ins."].join("\n"),
      reply_markup: { inline_keyboard: [[...[ ["Allow Once", "once"], ["Always Allow", "always"], ["Deny", "deny"] ].map(([text, choice]) =>
        ({ text, callback_data: `${CREDENTIAL_CALLBACK_PREFIX}${approval.id}:${choice}` }))]] },
    });
    const result: unknown = await response.json();
    if (!record(result) || result.ok !== true || !record(result.result) || typeof result.result.message_id !== "number") {
      throw new Error("Credential approval message unavailable");
    }
    this.store.bindApprovalMessage(approval.id, result.result.message_id);
    return approval.id;
  }

  async runtimeCall(method: string, body: Json | FormData): Promise<Response> {
    const fields: Json = {};
    if (body instanceof FormData) {
      for (const [key, value] of body) {
        if (Object.hasOwn(fields, key)) return denied();
        fields[key] = typeof value === "string" ? value : "uploaded-file";
      }
    } else Object.assign(fields, body);
    if (method === "verifyMiniAppIdentity") {
      if (body instanceof FormData || Object.keys(fields).length !== 2 || fields.userId !== this.store.userId ||
          typeof fields.initData !== "string" || fields.initData.length > 16_000) return denied();
      return json({ ok: true, result: validateMiniAppIdentity(fields.initData, this.token, this.store.userId, Date.now()) });
    }
    if (method === "getUpdates") {
      if (body instanceof FormData || Object.keys(fields).some(key => !["offset", "timeout", "limit", "allowed_updates"].includes(key))) return denied();
      try {
        let updates = this.store.readUpdates(Number(fields.offset ?? 0), Number(fields.limit ?? 100));
        if (!updates.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
          updates = this.store.readUpdates(Number(fields.offset ?? 0), Number(fields.limit ?? 100));
        }
        return json({ ok: true, result: updates });
      }
      catch { return denied(); }
    }
    // The fork initializes its poller with this call. Initialization belongs to
    // the broker; runtime requests cannot drop pending input or alter webhooks.
    if (method === "deleteWebhook") {
      return !(body instanceof FormData) && Object.keys(fields).every(key => key === "drop_pending_updates") && fields.drop_pending_updates !== true
        ? json({ ok: true, result: true }) : denied();
    }
    if (!authorizeRuntimeTelegramCall(this.store, method, fields)) return denied();
    if (method === "getFile" && (typeof fields.file_id !== "string" || !this.store.ownsFile(fields.file_id))) return denied();
    const response = await this.request(method, body);
    if (!response.ok) return response;
    const payload = await response.json() as Json;
    const messages = Array.isArray(payload.result) ? payload.result : [payload.result];
    if (method.startsWith("send") && !method.endsWith("Draft") && method !== "sendChatAction") {
      for (const message of messages) {
        if (!record(message) || !record(message.chat) || message.chat.id !== this.store.userId || typeof message.message_id !== "number") return denied();
        this.store.rememberOrdinaryMessage(message.message_id);
      }
    }
    if (method === "getFile") {
      if (!record(payload.result) || payload.result.file_id !== fields.file_id || typeof payload.result.file_path !== "string") return denied();
      this.store.bindFilePath(fields.file_id as string, payload.result.file_path);
    }
    return json(payload);
  }

  async download(path: string): Promise<Response> {
    if (!this.store.ownsFilePath(path)) return denied();
    try {
      const response = await this.upstream(`https://api.telegram.org/file/bot${this.token}/${path}`, {
        redirect: "error", signal: AbortSignal.timeout(35_000),
      });
      if (!response.ok) return denied();
      return new Response(response.body, { headers: { "content-type": "application/octet-stream" } });
    } catch { return denied(); }
  }
}
