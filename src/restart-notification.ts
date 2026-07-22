import { readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BridgeTelegramSurface } from "./instances.js";

const RESTART_PENDING_FILE = "restart-pending.json";
const RESTART_CONFIRMATION_TEXT =
  "✅ Bridge restarted successfully and is back online.";

interface TelegramConfigFile {
  botToken?: unknown;
  allowedUserId?: unknown;
  profiles?: unknown;
}

interface RestartMarker {
  version: 1;
  instanceId: string;
  telegramProfile: string;
}

export interface RestartMarkerOwner {
  instanceId: string;
  telegramProfile: string;
}

export interface NotifyPendingRestartOptions {
  stateDir: string;
  agentDir: string;
  instanceId?: string;
  telegramProfile?: string;
  telegramSurface?: BridgeTelegramSurface;
  fetchImpl?: typeof fetch;
}

export function markRestartPending(
  stateDir: string,
  owner?: RestartMarkerOwner,
): void {
  const content = owner
    ? `${JSON.stringify({ version: 1, ...owner }, null, 2)}\n`
    : "";
  writeFileSync(join(stateDir, RESTART_PENDING_FILE), content, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function notifyPendingRestart({
  stateDir,
  agentDir,
  instanceId,
  telegramProfile = "default",
  telegramSurface = { type: "private" },
  fetchImpl = fetch,
}: NotifyPendingRestartOptions): Promise<boolean> {
  const markerPath = join(stateDir, RESTART_PENDING_FILE);
  let markerContent: string;
  try {
    markerContent = await readFile(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Could not read restart notification marker: ${markerPath}`, {
      cause: error,
    });
  }
  const serializedMarker = markerContent.trim();
  if (serializedMarker) {
    let marker: RestartMarker;
    try {
      marker = JSON.parse(serializedMarker) as RestartMarker;
    } catch (error) {
      throw new Error("Restart notification marker is not valid JSON.", {
        cause: error,
      });
    }
    if (
      marker.version !== 1 ||
      typeof marker.instanceId !== "string" ||
      typeof marker.telegramProfile !== "string"
    ) {
      throw new Error("Restart notification marker has an unsupported format.");
    }
    if (instanceId && marker.instanceId !== instanceId) {
      throw new Error(
        `Restart notification marker belongs to instance ${marker.instanceId}, not ${instanceId}.`,
      );
    }
    if (marker.telegramProfile !== telegramProfile) {
      throw new Error(
        `Restart notification marker belongs to Telegram profile ${marker.telegramProfile}, not ${telegramProfile}.`,
      );
    }
  } else if (instanceId && instanceId !== "isaac") {
    throw new Error(
      "A legacy restart notification marker may be claimed only by the Isaac migration instance.",
    );
  }
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
    throw new Error("Telegram restart confirmation is not configured.");
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${selectedProfile.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: RESTART_CONFIRMATION_TEXT,
      }),
    },
  );
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error("Telegram restart confirmation failed: invalid response.", {
      cause: error,
    });
  }
  if (
    !response.ok ||
    typeof result !== "object" ||
    result === null ||
    (result as { ok?: unknown }).ok !== true
  ) {
    throw new Error(
      `Telegram restart confirmation failed (HTTP ${response.status}).`,
    );
  }

  await rm(markerPath);
  return true;
}
