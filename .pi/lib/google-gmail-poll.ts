import { commonArgs } from "./google-operations.js";
import { runGogJson, type GoogleRuntime } from "./google-transport.js";

type Runtime = GoogleRuntime & { binary: string; passwordFile: string; gogHome: string };
type Run = typeof runGogJson;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Closed read-only adapter for the tracked inbox checker (gog v0.34.1). */
export async function readGmailInboxPage(runtime: Runtime, account: string, query: string, page?: string, run: Run = runGogJson) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9@._+-]{0,199}$/.test(account) ||
    !/^in:inbox after:\d+ before:\d+$/.test(query) || (page !== undefined && (!page || page.length > 2048))) {
    throw new Error("Invalid Gmail polling request");
  }
  const execute = (args: string[], maxOutputBytes: number) => run({
    binary: runtime.binary, passwordFile: runtime.passwordFile, gogHome: runtime.gogHome,
    args: [...commonArgs(account), ...args], timeoutMs: 20_000, maxOutputBytes,
  });
  const result = await execute(["gmail", "messages", "search", query, "--max", "3",
    "--timezone", "UTC", ...(page ? ["--page", page] : [])], 64 * 1024);
  if (!record(result) || !Array.isArray(result.messages) || result.messages.length > 3 ||
    (result.nextPageToken !== undefined && (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 2048))) {
    throw new Error("Invalid Gmail message page");
  }
  const ids = result.messages.map((message) => {
    if (!record(message) || typeof message.id !== "string" || !ID.test(message.id)) {
      throw new Error("Invalid Gmail message ID");
    }
    return message.id;
  });
  // Search's date is the sender-supplied Date header. Get the internal delivery
  // timestamp separately, with sanitized content and no raw MIME or attachments.
  const messages = await Promise.all(ids.map(async (id) => {
    const result = await execute(["gmail", "get", id, "--format", "full", "--sanitize-content"], 2 * 1024 * 1024);
    if (!record(result) || !record(result.message)) throw new Error("Invalid Gmail message response");
    const message = result.message;
    const received = typeof message.internalDate === "string" && /^\d+$/.test(message.internalDate)
      ? Number(message.internalDate) : message.internalDate;
    if (message.id !== id || typeof message.threadId !== "string" || !ID.test(message.threadId) ||
      typeof received !== "number" || !Number.isSafeInteger(received) || received < 0 || received > 8.64e15 ||
      !record(message.headers) || !Array.isArray(message.labelIds) || !message.labelIds.every((label) => typeof label === "string") ||
      [message.body, message.headers.from, message.headers.subject].some((value) => value !== undefined && typeof value !== "string")) {
      throw new Error("Invalid Gmail message content");
    }
    return { id, threadId: message.threadId, internalDateIso: new Date(received).toISOString(),
      from: message.headers.from ?? "", subject: message.headers.subject ?? "", body: message.body ?? "",
      labels: message.labelIds };
  }));
  return { messages: messages.filter((message) => message.labels.includes("INBOX")), nextPageToken: result.nextPageToken ?? "" };
}
