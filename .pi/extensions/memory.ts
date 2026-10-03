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
const Patch = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  tags: Type.Optional(Tags), status: Type.Optional(Status),
  decay: Type.Optional(Type.Union([Decay, Type.Null()])),
  bodyEdits: Type.Optional(Type.Array(Type.Object({
    expectedText: Type.String({ minLength: 1, maxLength: 200_000 }),
    replacementText: Type.String({ maxLength: 200_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 20 })),
}, { additionalProperties: false, minProperties: 1 });

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
    description: "Read and change saved memories using revision-safe operations. Prepare a creation to see possible duplicates, then create with its token. Delete/share requests send user-only Telegram confirmation buttons; the tool cannot approve them.",
    promptSnippet: "Read, create, edit, delete, or share saved memories",
    promptGuidelines: [
      "Use assistant_memory for full-note reads and changes. Persist only memories the user explicitly asks to save.",
      "Before creating, call prepare_create and inspect possibleDuplicates. Update an existing note when it covers the same fact; use the creationToken only for a distinct new note. Reuse that token when checking a retried creation.",
      "Notes rank by usage. Person, preference, recipe, and reference notes are durable; list, event, and purchase notes fade when unused. Set decay to fading for a time-bound fact or idea of a durable type, or durable for a list or event that stays relevant; null restores the type default.",
      "Read the current revision before updating. Use bodyEdits with expectedText that occurs exactly once and replacementText; preserve unrelated content. Reread on REVISION_CONFLICT or TEXT_CONFLICT.",
      "For deletion or sharing a personal note with the household, call request_delete or request_share. The direct Telegram buttons own confirmation. Wait for the user and never claim success while confirmation is pending; never bypass this through the CLI.",
    ],
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("read"), id: Id }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("prepare_create"), type: StringEnum(["person", "preference", "event", "list", "recipe", "purchase", "reference"] as const),
        title: Type.String({ minLength: 1, maxLength: 200 }), tags: Type.Optional(Tags), body: Type.String({ maxLength: 200_000 }),
        decay: Type.Optional(Decay) }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("create"), creationToken: Id }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("update"), id: Id, ifRevision: Revision, patch: Patch }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("request_delete"), id: Id, ifRevision: Revision }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("request_share"), id: Id, ifRevision: Revision }, { additionalProperties: false }),
    ]),
    async execute(_id, params) {
      let details: { ok: boolean; result?: unknown; error?: ReturnType<typeof failure> };
      try {
        const current = app;
        if (!current) throw new MemoryError("UNAVAILABLE", "Memory tools require a configured bridge session");
        let result: unknown;
        switch (params.action) {
          case "read": result = await current.read(params.id); break;
          case "prepare_create": {
            const { action: _action, ...draft } = params;
            result = await current.prepareCreate(draft); break;
          }
          case "create": result = await current.create(params.creationToken); break;
          case "update": result = await current.update(params.id, params.ifRevision, params.patch); break;
          case "request_delete":
          case "request_share": {
            if (presenting) throw new MemoryError("MUTATION_BUSY", "Another memory confirmation is being presented");
            presenting = true;
            let token: string | undefined;
            try {
              pending = await current.requestConfirmation(params.action === "request_delete" ? "delete" : "share", params.id, params.ifRevision);
              token = pending.token;
              const operation = pending.operation;
              await presentTelegramSection(SECTION);
              result = { status: "awaiting_confirmation", operation, id: params.id, message: "Confirmation buttons sent. Wait for the user; nothing has changed yet." };
            } catch (error) {
              if (token) current.discard(token);
              throw error;
            } finally { pending = undefined; presenting = false; }
            break;
          }
          default: throw new MemoryError("INVALID_INPUT", "Unknown memory action");
        }
        details = { ok: true, result };
      } catch (error) { details = { ok: false, error: failure(error) }; }
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: !details.ok };
    },
  });
}
