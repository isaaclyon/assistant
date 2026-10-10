import type { ApprovedLoginVault } from "./approved-login-vault.js";
import type { TrustedTelegramStore } from "./trusted-telegram-store.js";
import type { TrustedTelegramTransport } from "./trusted-telegram-transport.js";

type Fields = Record<string, unknown>;
const only = (fields: Fields, names: string[]) => Object.keys(fields).length === names.length && names.every(key => Object.hasOwn(fields, key));
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { "content-type": "application/json", "cache-control": "no-store" } });
const unavailable = () => reply({ ok: false, error: "credential_unavailable" }, 403);

/** One instance, paired user, source vault and destination per private socket.
 * IPC supplies requests and references; only Telegram ingestion sets decisions.
 * Credential responses are for the protected host path, never tool results. */
export class ApprovedCredentialBroker {
  private requesting = false;
  private lastRequestAt = -Infinity;
  constructor(private readonly instance: string, private readonly store: TrustedTelegramStore,
    private readonly vault: ApprovedLoginVault, private readonly telegram: TrustedTelegramTransport,
    private readonly now: () => number = Date.now) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(instance)) throw new Error("Invalid approved credential instance");
  }

  async call(method: string, fields: Fields): Promise<Response> {
    try {
      if (method === "credentialCandidates") {
        if (!only(fields, ["origin"]) || typeof fields.origin !== "string") return unavailable();
        return reply({ ok: true, candidates: await this.vault.candidates(fields.origin) });
      }
      if (method === "credentialRequest") {
        if (!only(fields, ["itemId", "origin", "purpose"]) || typeof fields.itemId !== "string" ||
            typeof fields.origin !== "string" || typeof fields.purpose !== "string" ||
            !fields.purpose || fields.purpose.length > 300 || /[\0\r\n]/.test(fields.purpose) ||
            this.requesting || this.now() - this.lastRequestAt < 5000) return unavailable();
        this.requesting = true; this.lastRequestAt = this.now();
        try {
          const source = await this.vault.describeSource(fields.itemId, fields.origin);
          const id = await this.telegram.showApproval({ instance: this.instance, itemId: source.itemId, vaultId: source.vaultId,
            itemVersion: source.version, title: source.title, username: source.username, vaultName: source.vaultName,
            origin: source.origin, purpose: fields.purpose }, this.now());
          return reply({ ok: true, requestId: id, expiresAt: this.store.approval(id, this.now())!.expiresAt });
        } finally { this.requesting = false; }
      }
      if (!["credentialStatus", "credentialConsume", "credentialReconcile", "credentialCancel"].includes(method) ||
          !only(fields, ["requestId", "origin"]) || typeof fields.requestId !== "string" ||
          !/^[A-Za-z0-9_-]{24}$/.test(fields.requestId) || typeof fields.origin !== "string") return unavailable();
      const approval = this.store.approval(fields.requestId, this.now());
      if (!approval || approval.details.instance !== this.instance || approval.details.origin !== fields.origin) return unavailable();
      if (method === "credentialCancel") {
        this.store.cancelApproval(approval.id);
        return reply({ ok: true, state: this.store.approval(approval.id, this.now())!.state });
      }
      if (method === "credentialStatus") return reply({ ok: true, state: approval.state, copiedItem: this.store.copiedItem(approval.id) });
      if (method === "credentialReconcile") {
        if (!["consuming", "uncertain", "delivered"].includes(approval.state)) return unavailable();
        const found = await this.vault.reconcileCopy(approval);
        if (found) this.store.recordCopy(approval.id, found);
        return reply({ ok: true, state: approval.state, copiedItem: found });
      }
      const claim = this.store.claimApproval(approval.id, this.now());
      if (!claim) return unavailable();
      try {
        const resolved = await this.vault.resolveClaim(claim);
        try {
          if (resolved.copiedItem) this.store.recordCopy(claim.id, resolved.copiedItem);
          // Persist before serialization: a lost response must not release again.
          this.store.finishApproval(claim.id, "delivered");
          return reply({ ok: true, credential: { username: resolved.credential.username, password: resolved.credential.password },
            copiedItem: resolved.copiedItem });
        } finally { resolved.credential.username = ""; resolved.credential.password = ""; }
      } catch {
        if (this.store.approval(claim.id, this.now())?.state === "consuming") this.store.finishApproval(claim.id, "uncertain");
        return unavailable();
      }
    } catch { return unavailable(); }
  }
}
