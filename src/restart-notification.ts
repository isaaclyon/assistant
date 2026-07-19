import { readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const RESTART_PENDING_FILE = "restart-pending.json";
const RESTART_CONFIRMATION_TEXT =
  "✅ Bridge restarted successfully and is back online.";

interface TelegramConfigFile {
  botToken?: unknown;
  allowedUserId?: unknown;
}

export interface NotifyPendingRestartOptions {
  stateDir: string;
  agentDir: string;
  fetchImpl?: typeof fetch;
}

export function markRestartPending(stateDir: string): void {
  writeFileSync(join(stateDir, RESTART_PENDING_FILE), "", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function notifyPendingRestart({
  stateDir,
  agentDir,
  fetchImpl = fetch,
}: NotifyPendingRestartOptions): Promise<boolean> {
  const markerPath = join(stateDir, RESTART_PENDING_FILE);
  try {
    await readFile(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Could not read restart notification marker: ${markerPath}`, {
      cause: error,
    });
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
  if (
    typeof config.botToken !== "string" ||
    config.botToken.trim() === "" ||
    typeof config.allowedUserId !== "number" ||
    !Number.isSafeInteger(config.allowedUserId)
  ) {
    throw new Error("Telegram restart confirmation is not configured.");
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.allowedUserId,
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
