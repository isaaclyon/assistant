export const CREDENTIAL_CALLBACK_PREFIX = "credential-approval:";

export interface RuntimeTelegramPolicy {
  userId: number;
  /** Positive ownership recorded from successful ordinary sends or forwarded
   * user messages. Trusted approval messages must never enter this set. */
  ownsMessage(id: number): boolean;
  ownsCallback(id: string): boolean;
}

const commonSend = ["chat_id", "message_thread_id", "disable_notification", "protect_content", "reply_parameters", "reply_markup"];
const textFields = ["text", "parse_mode", "entities", "link_preview_options", "disable_web_page_preview"];
const captionFields = ["caption", "parse_mode", "caption_entities"];
const allowedFields: Record<string, readonly string[]> = {
  sendMessage: [...commonSend, ...textFields],
  sendMessageDraft: ["chat_id", "message_thread_id", "draft_id", "text", "parse_mode", "entities"],
  sendRichMessage: [...commonSend, "rich_message"],
  sendRichMessageDraft: ["chat_id", "message_thread_id", "draft_id", "rich_message"],
  sendChatAction: ["chat_id", "message_thread_id", "action"],
  sendPhoto: [...commonSend, ...captionFields, "photo", "has_spoiler", "show_caption_above_media"],
  sendDocument: [...commonSend, ...captionFields, "document", "thumbnail", "disable_content_type_detection"],
  sendAudio: [...commonSend, ...captionFields, "audio", "duration", "performer", "title", "thumbnail"],
  sendVoice: [...commonSend, ...captionFields, "voice", "duration"],
  sendVideo: [...commonSend, ...captionFields, "video", "duration", "width", "height", "thumbnail", "supports_streaming", "has_spoiler"],
  sendAnimation: [...commonSend, ...captionFields, "animation", "duration", "width", "height", "thumbnail", "has_spoiler"],
  sendMediaGroup: ["chat_id", "message_thread_id", "media", "disable_notification", "protect_content", "reply_parameters"],
  editMessageText: ["chat_id", "message_id", ...textFields, "reply_markup"],
  editMessageReplyMarkup: ["chat_id", "message_id", "reply_markup"],
  deleteMessage: ["chat_id", "message_id"],
  answerCallbackQuery: ["callback_query_id", "text", "show_alert", "cache_time"],
  setMyCommands: ["commands", "scope", "language_code"],
  getMe: [],
  getFile: ["file_id"],
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveId(value: unknown): number | undefined {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeMarkup(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (Array.isArray(value)) return value.length <= 100 && value.every(entry => safeMarkup(entry, depth + 1));
  if (!record(value)) return true;
  return Object.entries(value).every(([key, entry]) => {
    if (key === "callback_data" && (typeof entry !== "string" || entry.startsWith(CREDENTIAL_CALLBACK_PREFIX))) return false;
    return safeMarkup(entry, depth + 1);
  });
}

/** The trusted service calls this after decoding JSON or multipart fields.
 * Polling, offset acknowledgement, private-auth verification and credential
 * operations use separate endpoints. Never forward getUpdates/deleteWebhook
 * through this policy: the trusted service is their sole owner. */
export function authorizeRuntimeTelegramCall(policy: RuntimeTelegramPolicy, method: string, body: unknown): boolean {
  if (!Number.isSafeInteger(policy.userId) || policy.userId <= 0 || !record(body)) return false;
  if (!Object.hasOwn(allowedFields, method)) return false;
  const fields = allowedFields[method]!;
  if (Object.keys(body).some(key => !fields.includes(key))) return false;
  if (fields.includes("chat_id") && positiveId(body.chat_id) !== policy.userId) return false;
  if (fields.includes("message_id")) {
    const id = positiveId(body.message_id);
    if (id === undefined || !policy.ownsMessage(id)) return false;
  }
  if (method === "answerCallbackQuery" &&
      (typeof body.callback_query_id !== "string" || !policy.ownsCallback(body.callback_query_id))) return false;
  if (method === "setMyCommands" && body.scope !== undefined) {
    let scope = body.scope;
    try { if (typeof scope === "string") scope = JSON.parse(scope); } catch { return false; }
    if (!record(scope) || scope.type !== "chat" || positiveId(scope.chat_id) !== policy.userId ||
        Object.keys(scope).some(key => !["type", "chat_id"].includes(key))) return false;
  }
  if (body.reply_markup !== undefined) {
    let markup = body.reply_markup;
    try { if (typeof markup === "string") markup = JSON.parse(markup); } catch { return false; }
    if (!record(markup) || !safeMarkup(markup)) return false;
  }
  return safeMarkup(body);
}
