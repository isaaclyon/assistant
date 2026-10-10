import { describe, expect, it } from "vitest";
import { evaluateIsolationIdentity, parseLinuxProcessStatus } from "../src/isolation-audit.js";

const policy = { uid: 1200, gid: 1200 };
const safe = {
  uids: [1200, 1200, 1200, 1200], gids: [1200, 1200, 1200, 1200],
  groups: [1200], noNewPrivileges: true, capabilities: [0n, 0n, 0n, 0n, 0n],
};

describe("isolated service identity audit", () => {
  it("requires the actual process identity and sandbox, rather than account names", () => {
    expect(evaluateIsolationIdentity(safe, policy)).toEqual([]);
    expect(evaluateIsolationIdentity({ ...safe, uids: [1200, 1200, 0, 1200] }, policy)).toContain("unexpected_uid");
    expect(evaluateIsolationIdentity({ ...safe, gids: [1200, 1200, 1200, 0] }, policy)).toContain("unexpected_gid");
    expect(evaluateIsolationIdentity({ ...safe, groups: [1200, 988] }, policy)).toContain("supplementary_groups");
    expect(evaluateIsolationIdentity({ ...safe, noNewPrivileges: false }, policy)).toContain("privilege_escalation_enabled");
    expect(evaluateIsolationIdentity({ ...safe, capabilities: [0n, 0n, 0n, 1n, 0n] }, policy)).toContain("capabilities_present");
  });
  it("rejects invalid or root policy identities", () => {
    for (const uid of [0, -1, NaN, 1.5]) {
      expect(() => evaluateIsolationIdentity(safe, { ...policy, uid })).toThrow();
    }
  });
  it("parses every Linux identity and capability set without losing precision", () => {
    const status = "Name:\tnode\nUid:\t1200\t1200\t1200\t1200\nGid:\t1200\t1200\t1200\t1200\nGroups:\t1200\nNoNewPrivs:\t1\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0020000000000001\nCapAmb:\t0000000000000000\n";
    const parsed = parseLinuxProcessStatus(status);
    expect(parsed.capabilities[3]).toBe(0x0020000000000001n);
    expect(evaluateIsolationIdentity(parsed, policy)).toEqual(["capabilities_present"]);
    expect(() => parseLinuxProcessStatus(status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0\nNoNewPrivs:\t1"))).toThrow();
    expect(() => parseLinuxProcessStatus(status.replace("CapAmb:\t0000000000000000\n", ""))).toThrow();
    expect(() => parseLinuxProcessStatus(status.replace("1200\t1200\t1200\t1200", "1200 1200"))).toThrow();
  });
});
