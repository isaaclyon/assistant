import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ManagedRuntime } from "./isolated-deployment-config.js";

export type ServiceManager = Pick<ManagedRuntime, "manager" | "user" | "uid">;
export interface ManagedService { name: string; manager: ServiceManager; path: string }
export const systemManager: ServiceManager = { manager: "system", user: "root", uid: 0 };

export function serviceControlCommand(manager: ServiceManager, args: string[]): { binary: string; args: string[] } {
  if (manager.manager === "system") return { binary: "/usr/bin/systemctl", args };
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(manager.user) || !Number.isSafeInteger(manager.uid) || manager.uid <= 0) throw new Error("Invalid user service manager");
  return { binary: "/usr/sbin/runuser", args: ["-u", manager.user, "--", "/usr/bin/env", `XDG_RUNTIME_DIR=/run/user/${manager.uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${manager.uid}/bus`, "/usr/bin/systemctl", "--user", ...args] };
}

export async function controlService(manager: ServiceManager, ...args: string[]): Promise<string> {
  const command = serviceControlCommand(manager, args);
  try {
    return (await promisify(execFile)(command.binary, command.args, { timeout: 100_000, maxBuffer: 1_000_000,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } })).stdout.trim();
  } catch { throw new Error("Service manager operation failed"); }
}

export async function assertServiceQuiescent(service: ManagedService): Promise<void> {
  const query = (...args: string[]) => controlService(service.manager, "show", service.name, ...args, "--value");
  const [state, pid, enabled, fragment, dropIns] = await Promise.all([
    query("--property=ActiveState"), query("--property=MainPID"), query("--property=UnitFileState"),
    query("--property=FragmentPath"), query("--property=DropInPaths"),
  ]);
  if (!["inactive", "failed"].includes(state) || pid !== "0" || !["disabled", "masked", "not-found", ""].includes(enabled) ||
      ![service.path, "/dev/null", ""].includes(fragment) || dropIns !== "") throw new Error("Service quiescence or unit ownership could not be verified");
}

export async function assertConfiguredBridgeUnits(services: ManagedService[], managers: ServiceManager[], control = controlService): Promise<void> {
  for (const manager of managers) {
    // System services share one manager even when they run under different UIDs.
    const expected = new Set(services.filter(service => service.manager.manager === manager.manager &&
      (manager.manager === "system" || service.manager.uid === manager.uid)).map(service => service.name));
    for (const args of [["list-unit-files", "--no-legend"], ["list-units", "--all", "--no-legend", "--plain"]]) {
      // A glob with no matching unit files exits 1 on first migration.
      const listed = await control(manager, ...args, "--type=service");
      for (const line of listed.split("\n").filter(Boolean)) {
        const name = line.trim().split(/\s+/)[0]!;
        if (name.startsWith("pi-telegram-bridge") && !expected.has(name)) throw new Error("Unconfigured bridge unit requires explicit retirement before isolated deployment");
      }
    }
  }
}
