// Local type surface for the fork's Telegram command API, used only by the
// extensions typecheck (tsconfig.extensions.json `paths`). The fork ships raw
// TypeScript that does not compile under this repo's stricter settings
// (ADR-0002), so typechecking extensions against it directly reports the fork's
// own violations. This stub mirrors `@llblab/pi-telegram/commands`; runtime still
// resolves the real module. Keep it in sync with the fork's public surface.

export interface TelegramExtensionCommandContext {
  name: string;
  args: string;
  reply: (text: string) => Promise<void>;
  enqueuePrompt: (prompt: string) => Promise<void>;
}

export interface TelegramExtensionCommandRegistration {
  name: string;
  description?: string;
  order?: number;
  showInMenu?: boolean;
  emoji?: string;
  handler: (ctx: TelegramExtensionCommandContext) => Promise<void> | void;
}

export function registerTelegramCommand(
  registration: TelegramExtensionCommandRegistration,
): () => void;
