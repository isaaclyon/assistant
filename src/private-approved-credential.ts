import { setTimeout as delay } from "node:timers/promises";
import { runtimeTelegramFetch } from "./runtime-telegram-transport.js";

export type ApprovedCredentialResult = { status: "approved"; credential: { username: string; password: string }; copiedItem?: string }
  | { status: "denied" | "expired" | "cancelled" | "unavailable"; copiedItem?: string; copyStatus?: "unknown" };

/** Called only with the protected browser owner held. This returns secrets to
 * that owner, never to an extension tool result or a model-visible log. */
export async function privateApprovedCredential(itemId: string, origin: string, purpose: string, signal: AbortSignal,
  fetchImpl: typeof fetch = runtimeTelegramFetch): Promise<ApprovedCredentialResult> {
  if (!process.env.PI_TELEGRAM_TRUSTED_SOCKET || signal.aborted) return { status: "unavailable" };
  let requestId: string | undefined;
  let copyAttempted = false;
  const call = async (method: string, body: object) => {
    const response = await fetchImpl(`https://api.telegram.org/bot0:surrogate/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(method === "credentialConsume" ? 70_000 : 30_000)]),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error("Private credential request unavailable");
    return payload;
  };
  try {
    const requested = await call("credentialRequest", { itemId, origin, purpose });
    if (typeof requested.requestId !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(requested.requestId) ||
        !Number.isSafeInteger(requested.expiresAt)) throw new Error();
    requestId = requested.requestId;
    const until = Math.min(requested.expiresAt, Date.now() + 240_000);
    while (!signal.aborted && Date.now() < until) {
      const status = await call("credentialStatus", { requestId, origin });
      if (["denied", "expired"].includes(status.state)) return { status: status.state };
      if (["once", "always"].includes(status.state)) {
        copyAttempted = status.state === "always";
        // Exactly one attempt, even if the network response is lost.
        const resolved = await call("credentialConsume", { requestId, origin });
        const credential = resolved.credential;
        if (!credential || ![credential.username, credential.password].every(value => typeof value === "string" && value.length > 0 && value.length <= 1024)) throw new Error();
        return { status: "approved", credential: { username: credential.username, password: credential.password },
          ...(typeof resolved.copiedItem === "string" ? { copiedItem: resolved.copiedItem } : {}) };
      }
      if (status.state !== "pending") throw new Error();
      await delay(750, undefined, { signal });
    }
    return { status: signal.aborted ? "cancelled" : "expired" };
  } catch {
    // An independent copy may have succeeded despite a lost consume response.
    // Reconciliation is read-only and cannot recover/release the password.
    if (requestId && !signal.aborted) {
      try {
        const reconciled = await call("credentialReconcile", { requestId, origin });
        if (typeof reconciled.copiedItem === "string") return { status: "unavailable", copiedItem: reconciled.copiedItem };
      } catch { /* Fixed private failure status below. */ }
    }
    return { status: signal.aborted ? "cancelled" : "unavailable", ...(copyAttempted ? { copyStatus: "unknown" as const } : {}) };
  } finally {
    if (requestId && signal.aborted) {
      await fetchImpl("https://api.telegram.org/bot0:surrogate/credentialCancel", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, origin }),
        signal: AbortSignal.timeout(3000),
      }).then(response => response.body?.cancel()).catch(() => {});
    }
  }
}
