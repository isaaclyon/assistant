import { readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BridgeTelegramSurface } from "./instances.js";
import { sendTelegramNotification } from "./telegram-notification.js";

const RESTART_PENDING_FILE = "restart-pending.json";
const RESTART_CONFIRMATION_TEXT =
  "✅ Bridge restarted successfully and is back online.";

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
  await sendTelegramNotification({
    agentDir,
    telegramProfile,
    telegramSurface,
    text: RESTART_CONFIRMATION_TEXT,
    failureLabel: "Telegram restart confirmation",
    fetchImpl,
  });

  await rm(markerPath);
  return true;
}
