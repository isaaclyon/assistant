import type { MailChallenge } from "./private-email-code.js";

type Next = void | Array<"password" | "code">;
interface Page { submit(values: string[], expectedEmail?: string, signal?: AbortSignal): Promise<Next>; isEmailCodeFor(email: string): Promise<boolean> }

/** This closure and all mailbox results stay outside Pi and Mini App responses. */
export function createPrivateLoginSubmission(page: Page, prepare: (recipient: string, signal: AbortSignal) => Promise<MailChallenge | undefined>) {
  let recipient = "", initial = true, attempted = false, closed = false;
  let challenge: MailChallenge | undefined;
  return {
    async submit(values: string[], signal: AbortSignal): Promise<Next> {
      if (closed || signal.aborted) throw new Error("Private input ended");
      if (initial) {
        initial = false; recipient = values[0] ?? "";
        challenge = await prepare(recipient, signal).catch(() => undefined);
      }
      if (closed || signal.aborted) throw new Error("Private input ended");
      const requestedAt = Date.now();
      const next = await page.submit(values, undefined, signal);
      if (next?.[0] !== "code" || attempted || !challenge || !await page.isEmailCodeFor(recipient)) return next;
      attempted = true;
      const code = await challenge.takeCode(requestedAt, signal).catch(() => undefined);
      challenge = undefined;
      if (closed || signal.aborted) throw new Error("Private input ended");
      if (!code || !/^\d{6}$/.test(code)) return next;
      // The expected recipient is rechecked inside the bound browser operation,
      // immediately before filling. A changed challenge must never consume it.
      const privateValues = [code];
      try { return await page.submit(privateValues, recipient, signal); }
      finally { privateValues.fill(""); }
    },
    close() { closed = true; recipient = ""; challenge = undefined; },
  };
}
