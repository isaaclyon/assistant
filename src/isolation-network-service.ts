import { execFile } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { assertAdministratorPath } from "./isolation-admin-path.js";
import { isolationNetworkCleanup, isolationNetworkCommands, validateIsolationNetwork, type IsolationNetworkConfig } from "./isolation-network.js";

const exec = promisify(execFile);
const [action, filename] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid?.() !== 0 || !filename || process.argv.length !== 4 || !["start", "stop"].includes(action!)) {
  throw new Error("Network provisioning requires an administrator, action and root-owned configuration");
}
await assertAdministratorPath(filename);
const config: IsolationNetworkConfig = JSON.parse(await readFile(filename, "utf8"));
validateIsolationNetwork(config);
const directory = "/run/pi-isolation";
await mkdir(directory, { mode: 0o700, recursive: true });
await assertAdministratorPath(directory);
const journalPath = `${directory}/${config.namespace}.json`;
const run = (binary: string, args: string[]) => exec(binary, args, { timeout: 10_000, maxBuffer: 1_000_000,
  env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } });
if (action === "start") {
  if ((await readFile("/proc/sys/net/ipv4/ip_forward", "utf8")).trim() !== "1") throw new Error("Host forwarding must be explicitly enabled before provisioning");
  const [namespaces, links, rules] = await Promise.all([
    run("/usr/sbin/ip", ["-j", "netns", "list"]), run("/usr/sbin/ip", ["-j", "link", "show"]),
    run("/usr/sbin/iptables", ["--wait", "5", "-S"]),
  ]);
  if (JSON.parse(namespaces.stdout).some((entry: { name: string }) => entry.name === config.namespace) ||
      JSON.parse(links.stdout).some((entry: { ifname: string }) => [config.hostInterface, `${config.hostInterface}p`].includes(entry.ifname)) ||
      rules.stdout.includes(`PI_${config.hostInterface.toUpperCase()}_`)) {
    throw new Error("Isolation network names already exist; inspect before provisioning");
  }
  // Reserve ownership before the first mutation. Interrupted or ambiguous work
  // retains this record and cannot be silently retried against existing objects.
  const journal = await open(journalPath, "wx", 0o600);
  try {
    await journal.writeFile(JSON.stringify({ version: 1, config }) + "\n");
    await journal.sync();
    for (const command of isolationNetworkCommands(config)) await run(`/usr/sbin/${command.binary}`, command.args);
  } finally { await journal.close(); }
  console.log("Isolated network ready.");
} else {
  await assertAdministratorPath(journalPath);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  if (journal.version !== 1 || JSON.stringify(journal.config) !== JSON.stringify(config)) {
    throw new Error("Isolation network ownership record does not match configuration");
  }
  // Down first; a failure to remove the firewall must never leave an unfiltered
  // live interface. Missing objects are expected after interrupted provisioning.
  const failures: string[] = [];
  for (const command of isolationNetworkCleanup(config)) {
    try { await run(`/usr/sbin/${command.binary}`, command.args); }
    catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      if (!/Cannot find device|does not exist|No such file or directory|Bad rule|No chain\/target\/match by that name/.test(stderr)) {
        if (command.binary === "ip" && command.args[0] === "link" && command.args[1] === "set") {
          throw new Error("Cannot stop isolation interface; firewall and ownership record retained");
        }
        failures.push(command.binary);
      }
    }
  }
  if (failures.length) throw new Error("Isolation network cleanup incomplete; ownership record retained");
  await rm(journalPath);
  console.log("Isolated network removed.");
}
