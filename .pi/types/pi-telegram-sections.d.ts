export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramSectionView {
  text: string;
  parseMode?: "markdown" | "html" | "plain";
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramSectionContext {
  callbackData(action: string, payload?: string): string;
  enqueuePrompt(prompt: string): Promise<void>;
}

export interface TelegramSectionCallbackContext extends TelegramSectionContext {
  action: string;
  payload: string;
  answerCallback(text?: string): Promise<void>;
  edit(view: TelegramSectionView): Promise<void>;
}

export interface TelegramSectionRegistration {
  id: string;
  label: string;
  order?: number;
  render(ctx: TelegramSectionContext): TelegramSectionView | Promise<TelegramSectionView>;
  handleCallback?(
    ctx: TelegramSectionCallbackContext,
  ): "handled" | "pass" | Promise<"handled" | "pass">;
}

export function registerTelegramSection(
  registration: TelegramSectionRegistration,
): () => void;

export function presentTelegramSection(sectionId: string): Promise<void>;
