import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTelegramSection, presentTelegramSection } from "@llblab/pi-telegram/sections";
import { Type } from "typebox";
import { MemoryApplication } from "../../src/memory-application.ts";
import { MemoryError } from "../skills/personal-memory/scripts/store.mjs";

const SECTION = "assistant/memory-confirmation";
const Id = Type.String({ format: "uuid" });
const Revision = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const Tags = Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 30 });
const Status = StringEnum(["active", "superseded", "archived"] as const);
const Decay = StringEnum(["durable", "fading"] as const);
const NoteType = StringEnum(["person", "preference", "event", "list", "recipe", "purchase", "reference"] as const);
const Metadata = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  tags: Type.Optional(Tags), status: Type.Optional(Status),
  decay: Type.Optional(Type.Union([Decay, Type.Null()])),
}, { additionalProperties: false, minProperties: 1 });
const Draft = Type.Object({ type: NoteType,
  title: Type.String({ minLength: 1, maxLength: 200 }), tags: Type.Optional(Tags),
  body: Type.String({ maxLength: 200_000 }), decay: Type.Optional(Decay),
}, { additionalProperties: false });

function failure(error: unknown) {
  return error instanceof MemoryError
    ? { code: String(error.code), message: error.message }
    : { code: "MEMORY_UNAVAILABLE", message: "Memory is temporarily unavailable" };
}

export default function memoryExtension(pi: ExtensionAPI): void {
  let app: MemoryApplication | undefined;
  let unregister: (() => void) | undefined;
  let pending: Awaited<ReturnType<MemoryApplication["requestConfirmation"]>> | undefined;
  let presenting = false;
  const clear = () => {
    unregister?.(); unregister = undefined;
    app?.clear(); app = undefined; pending = undefined; presenting = false;
  };
  pi.on("session_shutdown", clear);
  pi.on("session_start", () => {
    clear();
    if (!process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID) return;
    try { app = new MemoryApplication({ env: process.env }); } catch { return; }
    unregister = registerTelegramSection({
      id: SECTION, label: "🧠 Memory confirmations", order: 25,
      render(ctx) {
        const item = pending; pending = undefined;
        if (!item || !app) return { text: "No memory change is awaiting confirmation.", parseMode: "plain" };
        app.bindConfirmation(item.token, ctx.chatId);
        return {
          text: `${item.operation === "delete" ? "Delete" : "Share with the household"}: ${item.preview.title}\n` +
            `Type: ${item.preview.type}\nUpdated: ${item.preview.updated}\n\n` +
            (item.operation === "share" ? "This makes the entire note visible to the household." : "This deletes the saved note. Conversation history and backups remain.") +
            "\nThis confirmation expires in 10 minutes and applies only to this version.",
          parseMode: "plain",
          replyMarkup: { inline_keyboard: [[
            { text: item.operation === "delete" ? "Confirm deletion" : "Confirm sharing", callback_data: ctx.callbackData("confirm", item.token) },
            { text: "Cancel", callback_data: ctx.callbackData("cancel", item.token) },
          ]] },
        };
      },
      async handleCallback(ctx) {
        if (ctx.action !== "confirm" && ctx.action !== "cancel") return "pass";
        await ctx.answerCallback();
        let text: string;
        try {
          if (!app) throw new MemoryError("STALE_ACTION", "Request a fresh memory confirmation");
          if (ctx.action === "cancel") {
            app.cancel(ctx.payload, ctx.chatId);
            text = "Cancelled. The memory was not changed.";
          } else {
            const result = await app.confirm(ctx.payload, ctx.chatId);
            text = result.deleted ? "Memory deleted." : "Memory shared with the household.";
            if ((result.git as { committed?: boolean } | undefined)?.committed === false) {
              text += " The change is saved, but its local Git commit failed.";
            }
          }
        } catch (error) { text = failure(error).message; }
        // Delivery errors must never retry an already consumed mutation.
        await ctx.edit({ text, parseMode: "plain", replyMarkup: { inline_keyboard: [] } });
        return "handled";
      },
    });
  });

  pi.registerTool({
    name: "assistant_memory",
    label: "Manage memories",
    description: "Create, read, update, list, delete, or share Markdown memories. Create with a draft to review possible duplicates, then commit its draftToken. Updates use exact oldText/newText edits, append, and metadata set with a required revision. Delete/share open user-only confirmation buttons.",
    promptSnippet: "Read, create, edit, delete, or share saved memories",
    promptGuidelines: [
      "Use assistant_memory for full-note reads and changes. Persist only memories the user explicitly asks to save.",
      "Create with draft, inspect possibleDuplicates, then create with draftToken for a distinct note. Update an existing note when it covers the same fact. Reuse the token on retries; tokens expire after ten minutes or session reset.",
      "Notes rank by usage. Person, preference, recipe, and reference notes are durable; list, event, and purchase notes fade when unused. Set decay to fading for a time-bound fact or idea of a durable type, or durable for a list or event that stays relevant; null restores the type default.",
      "Read before updating. Supply revision and edits (unique oldText/newText), append (Markdown at the end), and/or set (metadata). Edits run sequentially, then append, then one atomic save. Preserve unrelated content. Reread on conflict; restart list pagination on CURSOR_CONFLICT.",
      "Store stable facts in person notes, collections in lists, dated plans in events. Follow explicit list names. Confirm the actual saved type and title only when status is saved; review_required and confirmation_required mean nothing was saved.",
      "Delete and share open user-only Telegram confirmations. Never bypass confirmation through the CLI or filesystem. Use assistant_memory_search for discovery and list for filtered browsing. CLI is for maintenance only.",
    ],
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("read"), id: Id }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("create"), draft: Draft }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("create"), draftToken: Id }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("update"), id: Id, revision: Revision,
        edits: Type.Optional(Type.Array(Type.Object({ oldText: Type.String({ minLength: 1, maxLength: 200_000 }),
          newText: Type.String({ maxLength: 200_000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 })),
        append: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })), set: Type.Optional(Metadata),
      }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("list"), types: Type.Optional(Type.Array(NoteType, { minItems: 1, maxItems: 7, uniqueItems: true })),
        statuses: Type.Optional(Type.Array(Status, { minItems: 1, maxItems: 3, uniqueItems: true })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}:[0-9]{1,10}$" })),
      }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("delete"), id: Id, revision: Revision }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("share"), id: Id, revision: Revision }, { additionalProperties: false }),
    ]),
    async execute(_id, params) {
      let details: { ok: boolean; status: string; result?: unknown; error?: ReturnType<typeof failure> };
      try {
        const current = app;
        if (!current) throw new MemoryError("UNAVAILABLE", "Memory tools require a configured bridge session");
        let result: unknown;
        let status = "saved";
        switch (params.action) {
          case "read": result = await current.read(params.id); status = "read"; break;
          case "list": {
            const { action: _action, ...filters } = params;
            result = await current.list(filters); status = "listed"; break;
          }
          case "create": {
            if ("draft" in params) {
              const { creationToken, ...review } = await current.prepareCreate(params.draft);
              result = { ...review, draftToken: creationToken }; status = "review_required";
            } else result = await current.create(params.draftToken);
            break;
          }
          case "update": {
            const { action: _action, id, revision, ...changes } = params;
            result = await current.edit(id, revision, changes); break;
          }
          case "delete":
          case "share": {
            if (presenting) throw new MemoryError("MUTATION_BUSY", "Another memory confirmation is being presented");
            presenting = true;
            let token: string | undefined;
            try {
              pending = await current.requestConfirmation(params.action, params.id, params.revision);
              token = pending.token;
              const operation = pending.operation;
              await presentTelegramSection(SECTION);
              status = "confirmation_required";
              result = { operation, id: params.id, message: "Confirmation buttons sent. Wait for the user; nothing has changed yet." };
            } catch (error) {
              if (token) current.discard(token);
              throw error;
            } finally { pending = undefined; presenting = false; }
            break;
          }
          default: throw new MemoryError("INVALID_INPUT", "Unknown memory action");
        }
        details = { ok: true, status, result };
      } catch (error) {
        const failed = failure(error);
        details = { ok: false, status: ["REVISION_CONFLICT", "TEXT_CONFLICT", "CURSOR_CONFLICT"].includes(failed.code) ? "conflict" : "error", error: failed };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: !details.ok };
    },
  });
}
