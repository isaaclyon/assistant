import { describe, expect, it } from "vitest";
import { renderIsolationSupportUnits } from "../src/isolation-support-units.js";
const options = { instanceId: "synthetic", namespace: "pi-synthetic", nodePath: "/opt/pi/bin/node",
  releasePath: "/opt/pi/releases/fixture", networkConfigPath: "/etc/pi/network.json", endpointConfigPath: "/etc/pi/endpoints.json",
  brokerConfigPath: "/etc/pi/broker.json", brokerHome: "/var/lib/pi-broker", brokerUser: "pi-broker", runtimeGroup: "pi-personal" };
describe("isolated support units", () => {
  it("keeps source credentials under a separate nonprivileged identity with a protected socket directory", () => {
    const broker = renderIsolationSupportUnits(options).find(unit => unit.unitName.startsWith("pi-trusted-broker"))!;
    expect(broker.contents).toContain("User=pi-broker\nGroup=pi-personal");
    expect(broker.contents).toContain("RuntimeDirectoryMode=0750");
    expect(broker.contents).toContain("NoNewPrivileges=yes\nCapabilityBoundingSet=\nAmbientCapabilities=");
    expect(broker.contents).toContain("recovery-start-check.js");
    expect(broker.contents).not.toContain("NetworkNamespacePath");
  });
  it("provisions networking before either private proxy and bounds network setup", () => {
    const units = renderIsolationSupportUnits(options);
    expect(units).toHaveLength(4);
    expect(units[0]!.contents).toContain("TimeoutStartSec=90s");
    for (const unit of units.slice(2)) {
      expect(unit.contents).toContain("Requires=pi-isolated-network-pi-synthetic.service");
      expect(unit.contents).toContain("isolation-proxy-service.js");
    }
  });
  it("rejects privileged broker identities and executable paths controlled by the runtime", () => {
    for (const change of [{ brokerUser: "root" }, { runtimeGroup: "docker" }, { nodePath: "/home/operator/bin/node" },
      { releasePath: "/opt/pi/../home" }, { instanceId: "test\nUser=root" }]) {
      expect(() => renderIsolationSupportUnits({ ...options, ...change })).toThrow();
    }
  });
});
