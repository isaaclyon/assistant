import { describe, expect, it } from "vitest";
import { resolveBridgeInstanceConfig } from "../src/config.js";
import { parseBridgeInstanceManifest } from "../src/instances.js";
import { renderIsolatedInstanceServiceUnit } from "../src/service-unit.js";

const manifest = parseBridgeInstanceManifest(JSON.stringify({ version: 1, instances: [{
  id: "emma", displayName: "Test Bot", principal: "emma", telegramProfile: "emma",
  telegramSurface: { type: "private" }, workspaceCwd: "/var/lib/test-personal/workspace",
  capabilityProfile: "personal-emma", credentialScope: "emma-personal",
  memoryView: "owner-and-household", jobsRole: "target-only",
}] }));
const config = resolveBridgeInstanceConfig(manifest, "emma", {
  PI_CODING_AGENT_DIR: "/var/lib/test-personal/agent",
  PI_TELEGRAM_BRIDGE_STATE_ROOT: "/var/lib/test-personal/state",
  PI_TELEGRAM_BRIDGE_CONFIG_ROOT: "/etc/test-personal",
}, "/var/lib/test-personal", "/opt/assistant/release");
const options = {
  config, manifestPath: "/etc/test-personal/instances.json",
  nodePath: "/usr/bin/node", projectDir: "/opt/assistant/release",
  releaseSha: "a".repeat(40), user: "test-personal", group: "test-personal",
  privateHome: "/var/lib/test-personal",
  networkNamespace: "pi-synthetic", resolverPath: "/etc/test-personal/resolv.conf",
  auditPolicyPath: "/etc/test-personal/isolation-policy.json",
  trustedSocket: "/run/pi-broker-test/telegram.sock", browserAddress: "10.253.250.2",
  privateInputOrigin: "https://test.tail123.ts.net:8446", privateTakeoverOrigin: "https://test.tail123.ts.net:8447",
};

describe("isolated personal system unit", () => {
  it("retains recovery and session configuration with a nonprivileged system identity", () => {
    const { contents } = renderIsolatedInstanceServiceUnit(options);
    expect(contents).toContain("User=test-personal\nGroup=test-personal\n");
    expect(contents).toContain("NoNewPrivileges=yes");
    expect(contents).toContain("CapabilityBoundingSet=\nAmbientCapabilities=\n");
    expect(contents).toContain("ProtectSystem=strict");
    expect(contents).toContain("ProtectHome=yes");
    expect(contents).toContain("NetworkNamespacePath=/run/netns/pi-synthetic");
    expect(contents).toContain('BindReadOnlyPaths="/etc/test-personal/resolv.conf":/etc/resolv.conf');
    expect(contents).toContain("PI_TELEGRAM_TRUSTED_SOCKET=/run/pi-broker-test/telegram.sock");
    expect(contents).toContain('ReadWritePaths="/var/lib/test-personal"');
    expect(contents).toContain('Environment="PI_CODING_AGENT_DIR=/var/lib/test-personal/agent"');
    expect(contents).toContain("recovery-start-check.js");
    expect(contents).toContain("WantedBy=multi-user.target");
    expect(contents).not.toContain("WantedBy=default.target");
  });
  it.each(["root", "0", "sudo", "docker", "lxd", "bad\nUser=root", "-bad"])("rejects unsafe account %s", user => {
    expect(() => renderIsolatedInstanceServiceUnit({ ...options, user })).toThrow();
  });
  it("rejects privileged supplementary group choices", () => {
    expect(() => renderIsolatedInstanceServiceUnit({ ...options, group: "docker" })).toThrow();
  });
  it.each(["/", "/home/operator", "/var/lib/test-personal/../escape", "/var/lib/%u"])("rejects unsafe private root %s", privateHome => {
    expect(() => renderIsolatedInstanceServiceUnit({ ...options, privateHome })).toThrow();
  });
  it("rejects runtime or configuration inside the writable home", () => {
    expect(() => renderIsolatedInstanceServiceUnit({ ...options, projectDir: "/var/lib/test-personal/release" })).toThrow();
    expect(() => renderIsolatedInstanceServiceUnit({ ...options, manifestPath: "/var/lib/test-personal/config.json" })).toThrow();
  });
  it("requires all personal mutable roots inside the private home", () => {
    expect(() => renderIsolatedInstanceServiceUnit({ ...options, config: { ...config, agentDir: "/srv/shared/agent" } })).toThrow();
  });
});
