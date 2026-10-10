import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CREDENTIAL_CALLBACK_PREFIX } from "./trusted-telegram-policy.js";

export interface CredentialApprovalDetails {
  instance: string;
  itemId: string;
  vaultId: string;
  itemVersion: number;
  title: string;
  username: string;
  vaultName: string;
  origin: string;
  purpose: string;
}
export type CredentialApprovalState = "awaiting_message" | "pending" | "once" | "always" | "denied" | "expired" | "consuming" | "delivered" | "uncertain";
export interface CredentialApproval {
  id: string;
  details: CredentialApprovalDetails;
  expiresAt: number;
  messageId: number | null;
  state: CredentialApprovalState;
}
type Row = Record<string, unknown>;

function record(value: unknown): value is Row { return value !== null && typeof value === "object" && !Array.isArray(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

/** Owned exclusively by the trusted process, in its private state directory.
 * Persist updates before acknowledging Telegram, and approvals before release.
 * The runtime can acknowledge only updates it has actually been offered. */
export class TrustedTelegramStore {
  private readonly db: DatabaseSync;
  constructor(path: string, readonly userId: number, initialOffset = 0) {
    if (!positive(userId) || !Number.isSafeInteger(initialOffset) || initialOffset < 0) throw new Error("Invalid trusted Telegram identity");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ordinary_messages (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ordinary_callbacks (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ordinary_files (id TEXT PRIMARY KEY, path TEXT);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, details TEXT NOT NULL,
        expires_at INTEGER NOT NULL, message_id INTEGER UNIQUE, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_copies (id TEXT PRIMARY KEY REFERENCES approvals(id), item_id TEXT NOT NULL);
    `);
    for (const [key, value] of [["poll_offset", initialOffset], ["offered", initialOffset - 1], ["user_id", userId]] as const) {
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES (?, ?)").run(key, value);
    }
    if (this.value("user_id") !== userId) { this.db.close(); throw new Error("Trusted Telegram state belongs to another user"); }
  }
  close() { this.db.close(); }
  private value(key: string): number { return Number(this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key)!.value); }
  get pollOffset(): number { return this.value("poll_offset"); }
  ownsMessage = (id: number): boolean => !!this.db.prepare("SELECT 1 FROM ordinary_messages WHERE id = ?").get(id);
  ownsCallback = (id: string): boolean => !!this.db.prepare("SELECT 1 FROM ordinary_callbacks WHERE id = ?").get(id);
  ownsFile = (id: string): boolean => !!this.db.prepare("SELECT 1 FROM ordinary_files WHERE id = ?").get(id);
  ownsFilePath = (path: string): boolean => !!this.db.prepare("SELECT 1 FROM ordinary_files WHERE path = ?").get(path);
  bindFilePath(id: string, path: string): void {
    if (!/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/.test(path) || path.split("/").some(part => part === ".." || !part) ||
        this.db.prepare("UPDATE ordinary_files SET path = ? WHERE id = ?").run(path, id).changes !== 1) throw new Error("Invalid Telegram file ownership");
  }
  private rememberFiles(value: unknown, depth = 0): void {
    if (depth > 20 || value === null || typeof value !== "object") return;
    if (record(value) && typeof value.file_id === "string") this.db.prepare("INSERT OR IGNORE INTO ordinary_files (id) VALUES (?)").run(value.file_id);
    for (const child of Object.values(value)) this.rememberFiles(child, depth + 1);
  }
  rememberOrdinaryMessage(id: number): void {
    if (!positive(id) || this.db.prepare("SELECT 1 FROM approvals WHERE message_id = ?").get(id)) throw new Error("Invalid ordinary message identity");
    this.db.prepare("INSERT OR IGNORE INTO ordinary_messages VALUES (?)").run(id);
  }
  createApproval(details: CredentialApprovalDetails, now: number): CredentialApproval {
    const stringKeys = ["instance", "itemId", "vaultId", "title", "username", "vaultName", "origin", "purpose"] as const;
    if (!record(details) || Object.keys(details).length !== stringKeys.length + 1 ||
        stringKeys.some(key => typeof details[key] !== "string" || !details[key] || details[key].length > 1000 || /[\0\r\n]/.test(details[key]))) {
      throw new Error("Invalid credential approval details");
    }
    const origin = new URL(details.origin);
    if (origin.protocol !== "https:" || origin.origin !== details.origin || origin.username || origin.password ||
        !positive(details.itemVersion) || !Number.isSafeInteger(now) || now < 0 ||
        Object.values(details).some(value => typeof value === "string" && (!value || value.length > 1000 || /[\0\r\n]/.test(value)))) {
      throw new Error("Invalid credential approval details");
    }
    const id = randomBytes(18).toString("base64url"), expiresAt = now + 240_000;
    this.db.prepare("INSERT INTO approvals VALUES (?, ?, ?, NULL, 'awaiting_message')").run(id, JSON.stringify(details), expiresAt);
    return { id, details, expiresAt, messageId: null, state: "awaiting_message" };
  }
  bindApprovalMessage(id: string, messageId: number): void {
    if (!positive(messageId) || this.ownsMessage(messageId)) throw new Error("Invalid trusted approval message");
    const result = this.db.prepare("UPDATE approvals SET message_id = ?, state = 'pending' WHERE id = ? AND state = 'awaiting_message'").run(messageId, id);
    if (result.changes !== 1) throw new Error("Approval message is already bound or unavailable");
  }
  approval(id: string, now: number): CredentialApproval | undefined {
    this.db.prepare("UPDATE approvals SET state = 'expired' WHERE id = ? AND expires_at <= ? AND state IN ('awaiting_message','pending','once','always')").run(id, now);
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? { id, details: JSON.parse(String(row.details)), expiresAt: Number(row.expires_at),
      messageId: row.message_id === null ? null : Number(row.message_id), state: row.state as CredentialApprovalState } : undefined;
  }
  claimApproval(id: string, now: number): CredentialApproval | undefined {
    const approval = this.approval(id, now);
    if (!approval || !["once", "always"].includes(approval.state)) return;
    const changed = this.db.prepare("UPDATE approvals SET state = 'consuming' WHERE id = ? AND state = ? AND expires_at > ?").run(id, approval.state, now);
    return changed.changes === 1 ? approval : undefined;
  }
  cancelApproval(id: string): void {
    this.db.prepare("UPDATE approvals SET state = 'denied' WHERE id = ? AND state IN ('awaiting_message','pending','once','always')").run(id);
  }
  finishApproval(id: string, state: "delivered" | "uncertain"): void {
    if (this.db.prepare("UPDATE approvals SET state = ? WHERE id = ? AND state = 'consuming'").run(state, id).changes !== 1) {
      throw new Error("Approval is not being consumed");
    }
  }
  recordCopy(id: string, itemId: string): void {
    if (!/^[a-z0-9]{26}$/.test(itemId) || !this.db.prepare("SELECT 1 FROM approvals WHERE id = ? AND state IN ('consuming','uncertain','delivered')").get(id)) {
      throw new Error("Invalid approval copy identity");
    }
    this.db.prepare("INSERT INTO approval_copies VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET item_id = excluded.item_id").run(id, itemId);
  }
  copiedItem(id: string): string | undefined {
    const row = this.db.prepare("SELECT item_id FROM approval_copies WHERE id = ?").get(id);
    return row ? String(row.item_id) : undefined;
  }
  private privateMessage(value: unknown): value is Row {
    return record(value) && positive(value.message_id) && record(value.chat) &&
      value.chat.id === this.userId && value.chat.type === "private";
  }
  /** Return only callback IDs to acknowledge with fixed status text. Decisions
   * and callback payloads never enter the runtime queue. */
  ingest(updates: readonly unknown[], now: number): string[] {
    const consumed: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let nextOffset = this.pollOffset;
      let previousId = -1;
      for (const update of updates) {
        if (!record(update) || !Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) throw new Error("Invalid Telegram update identity");
        const updateId = update.update_id as number;
        if (updateId <= previousId) throw new Error("Telegram updates are not ordered");
        previousId = updateId;
        if (updateId < nextOffset) continue;
        nextOffset = updateId + 1;
        const callback = update.callback_query;
        if (record(callback) && typeof callback.data === "string" && callback.data.startsWith(CREDENTIAL_CALLBACK_PREFIX)) {
          if (record(callback.from) && callback.from.id === this.userId && this.privateMessage(callback.message) && typeof callback.id === "string") {
            const match = /^credential-approval:([A-Za-z0-9_-]{24}):(once|always|deny)$/.exec(callback.data);
            if (match) {
              this.db.prepare("UPDATE approvals SET state = ? WHERE id = ? AND message_id = ? AND state = 'pending' AND expires_at > ?")
                .run(match[2] === "deny" ? "denied" : match[2]!, match[1]!, callback.message.message_id as number, now);
            }
            consumed.push(callback.id);
          }
          continue;
        }
        const message = update.message ?? update.edited_message;
        let accepted = false;
        if (this.privateMessage(message) && record(message.from) && message.from.id === this.userId) {
          this.rememberOrdinaryMessage(message.message_id as number); accepted = true;
        } else if (record(callback) && record(callback.from) && callback.from.id === this.userId &&
                   this.privateMessage(callback.message) && this.ownsMessage(callback.message.message_id as number) && typeof callback.id === "string") {
          this.db.prepare("INSERT OR IGNORE INTO ordinary_callbacks VALUES (?)").run(callback.id); accepted = true;
        }
        if (accepted) {
          this.rememberFiles(update);
          this.db.prepare("INSERT OR IGNORE INTO updates VALUES (?, ?)").run(updateId, JSON.stringify(update));
        }
      }
      this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'poll_offset'").run(nextOffset);
      this.db.exec("COMMIT");
      return consumed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  readUpdates(offset: number, limit = 100): unknown[] {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.value("offered") + 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid runtime update acknowledgement");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM updates WHERE id < ?").run(offset);
      const rows = this.db.prepare("SELECT id, payload FROM updates WHERE id >= ? ORDER BY id LIMIT ?").all(offset, limit);
      const last = rows.at(-1);
      if (last) this.db.prepare("UPDATE metadata SET value = MAX(value, ?) WHERE key = 'offered'").run(Number(last.id));
      this.db.exec("COMMIT");
      return rows.map(row => JSON.parse(String(row.payload)));
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
