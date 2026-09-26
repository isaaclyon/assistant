export function registerTelegramUpdateHandler(handler: (update: unknown) => "consume" | "pass" | void | Promise<"consume" | "pass" | void>): () => void;
