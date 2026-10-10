import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { CredentialApproval } from "./trusted-telegram-store.js";

const execFileAsync = promisify(execFile);
export interface ApprovedVaultConfig {
  binary: string;
  tokenFile: string;
  sourceVault: string;
  sourceName: string;
  destinationVault: string;
  home: string;
}
export interface PrivateLoginValue {
  itemId: string;
  vaultId: string;
  version: number;
  title: string;
  username: string;
  password: string;
  origin: string;
}
export type PrivateVaultCommand = (args: readonly string[], input?: string) => Promise<unknown>;
const itemId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{26}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fieldString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;

/** A broker-private command runner. Neither configuration nor stdout is exposed
 * through the model's tool interface; errors discard CLI payloads and causes. */
export function privateVaultCommand(config: ApprovedVaultConfig): PrivateVaultCommand {
  if (![config.binary, config.tokenFile, config.home].every(isAbsolute) ||
      !itemId(config.sourceVault) || !itemId(config.destinationVault) || config.sourceVault === config.destinationVault) {
    throw new Error("Invalid approved-login vault configuration");
  }
  return async (args, input) => {
    try {
      const stat = await lstat(config.tokenFile);
      if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error();
      const token = (await readFile(config.tokenFile, "utf8")).trim();
      if (!token.startsWith("ops_") || token.length > 20_000 || /\s/.test(token)) throw new Error();
      // execFile has no stdin option; the child pipe carries the template.
      const operation = execFileAsync(config.binary, [...args, "--format=json"], {
        env: { HOME: config.home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", OP_SERVICE_ACCOUNT_TOKEN: token },
        timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
      });
      operation.child.stdin?.on("error", () => {});
      operation.child.stdin?.end(input);
      const result = await operation;
      return JSON.parse(result.stdout);
    } catch { throw new Error("Approved-login vault operation unavailable"); }
  };
}

export function parsePrivateLogin(value: unknown, vaultId: string, selectedItem: string, origin: string): PrivateLoginValue {
  if (!record(value) || value.id !== selectedItem || !record(value.vault) || value.vault.id !== vaultId ||
      value.category !== "LOGIN" || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
      !fieldString(value.title) || !Array.isArray(value.fields) || !Array.isArray(value.urls)) throw new Error("Login item is unavailable");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Invalid login origin");
  if (!value.urls.some(entry => {
    try { return record(entry) && typeof entry.href === "string" && new URL(entry.href).origin === origin &&
      !new URL(entry.href).username && !new URL(entry.href).password; } catch { return false; }
  })) throw new Error("Login website does not match");
  const username = value.fields.filter(field => record(field) && field.purpose === "USERNAME");
  const password = value.fields.filter(field => record(field) && field.purpose === "PASSWORD");
  if (username.length !== 1 || password.length !== 1 || !fieldString(username[0].value) || !fieldString(password[0].value)) throw new Error("Login fields are ambiguous or unavailable");
  return { itemId: selectedItem, vaultId, version: Number(value.version), title: value.title,
    username: username[0].value, password: password[0].value, origin };
}

export class ApprovedLoginVault {
  constructor(private readonly config: ApprovedVaultConfig, private readonly command: PrivateVaultCommand = privateVaultCommand(config)) {}
  async candidates(origin: string): Promise<Array<{ reference: string; title: string }>> {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Invalid login origin");
    const items = await this.command(["item", "list", "--vault", this.config.sourceVault, "--categories", "Login"]);
    if (!Array.isArray(items)) throw new Error("Login candidates unavailable");
    return items.filter(value => record(value) && itemId(value.id) && fieldString(value.title) &&
      record(value.vault) && value.vault.id === this.config.sourceVault && value.category === "LOGIN" &&
      Array.isArray(value.urls) && value.urls.some(entry => {
        try { return record(entry) && typeof entry.href === "string" && new URL(entry.href).origin === origin; }
        catch { return false; }
      })).slice(0, 50).map(value => ({ reference: `source:${value.id}`, title: value.title }));
  }
  async readSource(id: string, origin: string): Promise<PrivateLoginValue> {
    if (!itemId(id)) throw new Error("Invalid login item reference");
    return parsePrivateLogin(await this.command(["item", "get", id, "--vault", this.config.sourceVault]), this.config.sourceVault, id, origin);
  }
  async describeSource(id: string, origin: string): Promise<Omit<PrivateLoginValue, "password"> & { vaultName: string }> {
    const login = await this.readSource(id, origin);
    try {
      return { itemId: login.itemId, vaultId: login.vaultId, version: login.version, title: login.title,
        username: login.username, origin: login.origin, vaultName: this.config.sourceName };
    } finally { login.password = ""; login.username = ""; }
  }
  /** Read-only reconciliation after an interrupted/ambiguous write. Absence or
   * duplication does not authorize another write or another secret delivery. */
  async reconcileCopy(approval: CredentialApproval): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(approval.id) || !["consuming", "uncertain", "delivered"].includes(approval.state)) {
      throw new Error("Invalid copy reconciliation");
    }
    const tag = `bridge-approval-${approval.id}`;
    const items = await this.command(["item", "list", "--vault", this.config.destinationVault, "--tags", tag, "--categories", "Login"]);
    if (!Array.isArray(items)) throw new Error("Login copy reconciliation unavailable");
    const matches = items.filter(value => record(value) && Array.isArray(value.tags) && value.tags.includes(tag));
    if (!matches.length) return;
    if (matches.length !== 1 || !itemId(matches[0].id)) throw new Error("Login copy reconciliation is ambiguous");
    const raw = await this.command(["item", "get", matches[0].id, "--vault", this.config.destinationVault]);
    const copied = parsePrivateLogin(raw, this.config.destinationVault, matches[0].id, approval.details.origin);
    try {
      if (!record(raw) || !Array.isArray(raw.tags) || !raw.tags.includes(tag) || copied.title !== approval.details.title ||
          copied.username !== approval.details.username) throw new Error("Login copy identity changed");
      return copied.itemId;
    } finally { copied.username = ""; copied.password = ""; }
  }
  /** Call only after an atomic trusted-store claim. A failed/ambiguous create
   * leaves that claim consumed; reconciliation can locate its unique tag later.
   * No automatic retry is permitted, including after broker restart. */
  async resolveClaim(claim: CredentialApproval): Promise<{ credential: PrivateLoginValue; copiedItem?: string }> {
    if (!["once", "always"].includes(claim.state) || claim.details.vaultId !== this.config.sourceVault) throw new Error("Invalid credential claim");
    const credential = await this.readSource(claim.details.itemId, claim.details.origin);
    try {
      if (credential.version !== claim.details.itemVersion || credential.title !== claim.details.title || credential.username !== claim.details.username) {
        throw new Error("The selected login changed after approval");
      }
      if (claim.state === "once") return { credential };
      const template = {
        title: credential.title, category: "LOGIN", urls: [{ href: credential.origin, primary: true }],
        tags: [`bridge-approval-${claim.id}`],
        fields: [
          { id: "username", type: "STRING", purpose: "USERNAME", value: credential.username },
          { id: "password", type: "CONCEALED", purpose: "PASSWORD", value: credential.password },
        ],
      };
      const created = await this.command(["item", "create", "-", "--vault", this.config.destinationVault], JSON.stringify(template));
      if (!record(created) || !itemId(created.id) || created.id === credential.itemId) throw new Error("Could not verify independent login copy");
      const copied = parsePrivateLogin(await this.command(["item", "get", created.id, "--vault", this.config.destinationVault]), this.config.destinationVault, created.id, credential.origin);
      try {
        if (copied.username !== credential.username || copied.password !== credential.password || copied.title !== credential.title) throw new Error("Login copy did not match");
      } finally { copied.username = ""; copied.password = ""; }
      return { credential, copiedItem: created.id };
    } catch (error) { credential.username = ""; credential.password = ""; throw error; }
  }
}
