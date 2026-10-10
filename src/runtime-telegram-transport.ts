import { trustedTelegramFetch } from "./trusted-telegram-ipc.js";
import { validateMiniAppIdentity } from "./secure-input-demo.js";

/** Standalone notification and private-browser helpers use the same configured
 * transport as the pinned fork, including when run in a child process. */
export const runtimeTelegramFetch: typeof fetch = (input, init) => {
  const socket = process.env.PI_TELEGRAM_TRUSTED_SOCKET;
  return socket ? trustedTelegramFetch(socket)(input, init) : fetch(input, init);
};

export async function validateRuntimeMiniAppIdentity(raw: string, token: string, userId: number, now: number): Promise<boolean> {
  if (!process.env.PI_TELEGRAM_TRUSTED_SOCKET) return validateMiniAppIdentity(raw, token, userId, now);
  try {
    const response = await runtimeTelegramFetch("https://api.telegram.org/bot0:surrogate/verifyMiniAppIdentity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData: raw, userId }),
    });
    const payload = await response.json() as { ok?: unknown; result?: unknown };
    return response.ok && payload.ok === true && payload.result === true;
  } catch { return false; }
}
