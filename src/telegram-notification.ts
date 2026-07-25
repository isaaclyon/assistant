import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeTelegramSurface } from "./instances.js";

interface TelegramConfigFile {
  botToken?: unknown;
  allowedUserId?: unknown;
  profiles?: unknown;
}

export interface TelegramNotificationOptions {
  agentDir: string;
  telegramProfile?: string;
  telegramSurface?: BridgeTelegramSurface;
  text: string;
  failureLabel: string;
  fetchImpl?: typeof fetch;
}

export async function sendTelegramNotification({
  agentDir,
  telegramProfile = "default",
  telegramSurface = { type: "private" },
  text,
  failureLabel,
  fetchImpl = fetch,
}: TelegramNotificationOptions): Promise<void> {
  const configPath = join(agentDir, "telegram.json");
  let config: TelegramConfigFile;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as TelegramConfigFile;
  } catch (error) {
    throw new Error(`Could not read Telegram configuration: ${configPath}`, {
      cause: error,
    });
  }
  const selectedProfile: TelegramConfigFile | undefined =
    telegramProfile === "default"
      ? config
      : typeof config.profiles === "object" &&
          config.profiles !== null &&
          !Array.isArray(config.profiles)
        ? ((config.profiles as Record<string, unknown>)[
            telegramProfile
          ] as TelegramConfigFile | undefined)
        : undefined;
  const chatId =
    telegramSurface.type === "household-group"
      ? telegramSurface.chatId
      : selectedProfile?.allowedUserId;
  if (
    typeof selectedProfile?.botToken !== "string" ||
    selectedProfile.botToken.trim() === "" ||
    typeof chatId !== "number" ||
    !Number.isSafeInteger(chatId)
  ) {
    throw new Error(`${failureLabel} is not configured.`);
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${selectedProfile.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
  );
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`${failureLabel} failed: invalid response.`, { cause: error });
  }
  if (
    !response.ok ||
    typeof result !== "object" ||
    result === null ||
    (result as { ok?: unknown }).ok !== true
  ) {
    throw new Error(`${failureLabel} failed (HTTP ${response.status}).`);
  }
}
