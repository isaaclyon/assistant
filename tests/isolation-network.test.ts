import { describe, expect, it } from "vitest";
import { isolationNetworkCommands, isolationNetworkCleanup, validateIsolationNetwork, type IsolationNetworkConfig } from "../src/isolation-network.js";

const config: IsolationNetworkConfig = { namespace: "pi-synthetic", hostInterface: "pisynthetic", subnet: "10.253.250.0/30",
  hostAddress: "10.253.250.1", runtimeAddress: "10.253.250.2", dns: "1.1.1.1",
  localServices: [{ address: "192.168.40.10", port: 443 }], proxyPorts: [8446, 8447] };
describe("isolated runtime networking", () => {
  it("blocks host control and private network egress before bringing the interface up", () => {
    const commands = isolationNetworkCommands(config), rules = commands.map(command => command.args.join(" "));
    const up = rules.findIndex(rule => rule === "link set pisynthetic up");
    expect(rules.findIndex(rule => rule.includes("-I INPUT 1 -i pisynthetic"))).toBeLessThan(up);
    expect(rules).toContain("--wait 5 -A PI_PISYNTHETIC_IN -j REJECT");
    expect(rules).toContain("--wait 5 -A PI_PISYNTHETIC_OUT -d 100.64.0.0/10 -j REJECT");
    expect(rules.findIndex(rule => rule.includes("-d 192.168.40.10 -p tcp --dport 443"))).toBeLessThan(rules.findIndex(rule => rule.includes("-d 192.168.0.0/16")));
    expect(rules.some(rule => rule.includes("net.ipv6.conf.all.disable_ipv6=1"))).toBe(true);
    expect(rules).not.toContain("--wait 5 -F");
  });
  it("cleans up only its own exact rules and named chains", () => {
    for (const command of isolationNetworkCleanup(config).filter(command => command.binary === "iptables")) {
      expect(command.args.join(" ")).toMatch(/PI_PISYNTHETIC|pisynthetic|10\.253\.250\.0\/30/);
    }
  });
  it("rejects arbitrary names, routes, shell payloads and host service grants", () => {
    for (const change of [{ namespace: "default" }, { hostInterface: "eth0" }, { subnet: "0.0.0.0/0" },
      { hostAddress: "10.253.250.5" }, { runtimeAddress: "127.0.0.1" }, { dns: "1.1.1.1;reboot" },
      { proxyPorts: [22] }, { localServices: [{ address: "127.0.0.1", port: 8790 }] }]) {
      expect(() => validateIsolationNetwork({ ...config, ...change })).toThrow();
    }
  });
});
