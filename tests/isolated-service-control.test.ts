import { describe, expect, it } from "vitest";
import { assertConfiguredBridgeUnits, serviceControlCommand, systemManager, type ManagedService } from "../src/isolated-service-control.js";
const personal: ManagedService = { name: "pi-telegram-bridge-personal.service", path: "/etc/systemd/system/pi-telegram-bridge-personal.service",
  manager: { manager: "system", user: "personal", uid: 999 } };
describe("mixed system and user service managers", () => {
  it("discovers an empty first-migration manager without a failing glob query", async () => {
    await assertConfiguredBridgeUnits([personal], [systemManager], async (_manager, ...args) => {
      if (args.some(arg => arg.includes("*"))) throw new Error("systemctl exits 1 for unmatched glob");
      return "ssh.service enabled enabled\n";
    });
  });
  it("recognizes a system service's non-root process identity", async () => {
    await assertConfiguredBridgeUnits([personal], [systemManager], async () => `${personal.name} disabled enabled`);
    await expect(assertConfiguredBridgeUnits([personal], [systemManager], async () => "pi-telegram-bridge-forgotten.service loaded active running")).rejects.toThrow("Unconfigured");
  });
  it("keeps separate user buses and refuses a bridge owned by another manager", async () => {
    const builder = { manager: "user" as const, user: "builder", uid: 1000 };
    expect(serviceControlCommand(builder, ["is-active", "synthetic.service"])).toMatchObject({ binary: "/usr/sbin/runuser",
      args: ["-u", "builder", "--", "/usr/bin/env", "XDG_RUNTIME_DIR=/run/user/1000", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "/usr/bin/systemctl", "--user", "is-active", "synthetic.service"] });
    await expect(assertConfiguredBridgeUnits([personal], [builder], async () => `${personal.name} enabled enabled`)).rejects.toThrow("Unconfigured");
  });
});
