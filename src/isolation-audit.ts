import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

export interface IsolationIdentity {
  uids: number[];
  gids: number[];
  groups: number[];
  noNewPrivileges: boolean;
  capabilities: bigint[];
}

export interface IsolationIdentityPolicy { uid: number; gid: number }

/** This is a process check: account names and a rendered unit are not evidence
 * of the credentials or sandbox of a running service. */
export function evaluateIsolationIdentity(
  identity: IsolationIdentity, policy: IsolationIdentityPolicy,
): string[] {
  if (![policy.uid, policy.gid].every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error("Isolation policy requires non-root numeric identities");
  }
  const failures: string[] = [];
  if (identity.uids.length !== 4 || identity.uids.some(id => id !== policy.uid)) failures.push("unexpected_uid");
  if (identity.gids.length !== 4 || identity.gids.some(id => id !== policy.gid)) failures.push("unexpected_gid");
  if (identity.groups.some(id => id !== policy.gid)) failures.push("supplementary_groups");
  if (!identity.noNewPrivileges) failures.push("privilege_escalation_enabled");
  if (identity.capabilities.length !== 5 || identity.capabilities.some(value => value !== 0n)) failures.push("capabilities_present");
  return failures;
}

export function parseLinuxProcessStatus(status: string): IsolationIdentity {
  const field = (key: string) => {
    const lines = status.split("\n").filter(line => line.startsWith(`${key}:`));
    if (lines.length !== 1) throw new Error("Incomplete or ambiguous Linux process status");
    return lines[0]!.slice(key.length + 1).trim();
  };
  const numbers = (key: string, count?: number) => {
    const value = field(key);
    if (value !== "" && !/^\d+(?:\s+\d+)*$/.test(value)) throw new Error("Invalid Linux process identity");
    const parsed = value === "" ? [] : value.split(/\s+/).map(Number);
    if ((count !== undefined && parsed.length !== count) || parsed.some(id => !Number.isSafeInteger(id))) {
      throw new Error("Invalid Linux process identity");
    }
    return parsed;
  };
  const noNewPrivileges = field("NoNewPrivs");
  if (!/^[01]$/.test(noNewPrivileges)) throw new Error("Invalid Linux privilege status");
  return {
    uids: numbers("Uid", 4), gids: numbers("Gid", 4), groups: numbers("Groups"),
    noNewPrivileges: noNewPrivileges === "1",
    capabilities: ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(key => {
      const value = field(key);
      if (!/^[0-9a-f]{16}$/i.test(value)) throw new Error("Invalid Linux capability status");
      return BigInt(`0x${value}`);
    }),
  };
}

export interface IsolationPathProbe {
  /** Public role name only; diagnostics never expose the underlying path. */
  role: string;
  path: string;
  kind: "immutable" | "private-directory" | "inaccessible";
}

export interface IsolationAuditPolicy extends IsolationIdentityPolicy {
  paths: readonly IsolationPathProbe[];
}

async function permitted(path: string, mode: number): Promise<boolean> {
  try { await access(path, mode); return true; }
  catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    // Missing files and other probe errors do not prove that a secret is protected.
    throw error;
  }
}

/** Run in the candidate's real systemd context before starting Pi. Read-only,
 * content-free probes cover DAC/ACL and mount restrictions visible to this UID.
 * This is one acceptance gate, not a complete sandbox proof: IPC authorization,
 * network services, descendants and configuration still need separate checks. */
export async function auditIsolationProcess(policy: IsolationAuditPolicy): Promise<string[]> {
  if (process.platform !== "linux") throw new Error("Isolation audit requires Linux");
  const identity = parseLinuxProcessStatus(await readFile("/proc/self/status", "utf8"));
  const failures = evaluateIsolationIdentity(identity, policy);
  // fs.access checks the real UID/GID; all four IDs must match before probing.
  if (failures.length) return failures;
  const roles = new Set<string>();
  for (const probe of policy.paths) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(probe.role) || roles.has(probe.role) ||
        !isAbsolute(probe.path) || normalize(probe.path) !== probe.path || probe.path === "/") {
      throw new Error("Invalid isolation path policy");
    }
    roles.add(probe.role);
    try {
      if (probe.kind === "inaccessible") {
        if (await permitted(probe.path, constants.R_OK)) failures.push(`${probe.role}:readable`);
        if (await permitted(probe.path, constants.W_OK)) failures.push(`${probe.role}:writable`);
        continue;
      }
      if (await realpath(probe.path) !== probe.path) {
        failures.push(`${probe.role}:noncanonical`); continue;
      }
      const metadata = await lstat(probe.path);
      if (probe.kind === "private-directory") {
        if (!metadata.isDirectory() || metadata.uid !== policy.uid || metadata.gid !== policy.gid ||
            (metadata.mode & 0o7777) !== 0o700) failures.push(`${probe.role}:not_private`);
        if (!await permitted(probe.path, constants.R_OK | constants.W_OK | constants.X_OK)) failures.push(`${probe.role}:unusable`);
      }
      // Every ancestor must resist replacement, even when the file itself is read-only.
      let cursor = probe.kind === "immutable" ? probe.path : dirname(probe.path);
      for (;;) {
        if (await permitted(cursor, constants.W_OK)) {
          failures.push(`${probe.role}:mutable_ancestry`); break;
        }
        if (cursor === "/") break;
        cursor = dirname(cursor);
      }
    } catch {
      failures.push(`${probe.role}:probe_failed`);
    }
  }
  return failures;
}
