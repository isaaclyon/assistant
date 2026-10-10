/** A dedicated network namespace keeps the unprivileged runtime away from host
 * loopback administrative listeners while retaining explicitly allowed egress.
 * All command arguments derive from administrator-owned configuration. */
export interface IsolationNetworkConfig {
  namespace: string;
  hostInterface: string;
  subnet: string;
  hostAddress: string;
  runtimeAddress: string;
  dns: string;
  localServices: Array<{ address: string; port: number }>;
  proxyPorts: number[];
}
export interface IsolationNetworkCommand { binary: "ip" | "iptables"; args: string[] }
const octets = (value: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split(".").every(part => String(Number(part)) === part && Number(part) <= 255);
const port = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;

export function validateIsolationNetwork(value: IsolationNetworkConfig): void {
  if (!/^pi-[a-z0-9-]{1,24}$/.test(value.namespace) || !/^pi[a-z0-9]{1,10}$/.test(value.hostInterface) ||
      !/^10\.\d{1,3}\.\d{1,3}\.0\/30$/.test(value.subnet) || !octets(value.subnet.slice(0, -3)) ||
      value.hostAddress !== value.subnet.replace("0/30", "1") || value.runtimeAddress !== value.subnet.replace("0/30", "2") ||
      !octets(value.dns) || !Array.isArray(value.localServices) || value.localServices.length > 16 ||
      value.localServices.some(service => !octets(service.address) || service.address.startsWith("127.") ||
        !Number.isInteger(service.port) || service.port < 1 || service.port > 65535 || service.address === value.hostAddress || service.address === value.runtimeAddress) ||
      !Array.isArray(value.proxyPorts) || value.proxyPorts.length > 4 || value.proxyPorts.some(value => !port(value)) ||
      new Set(value.proxyPorts).size !== value.proxyPorts.length) throw new Error("Invalid isolation network configuration");
}

export function isolationNetworkCommands(config: IsolationNetworkConfig): IsolationNetworkCommand[] {
  validateIsolationNetwork(config);
  const { namespace, hostInterface: host, subnet, hostAddress, runtimeAddress } = config;
  const peer = `${host}p`, chain = `PI_${host.toUpperCase()}`;
  const commands: IsolationNetworkCommand[] = [];
  const ip = (...args: string[]) => commands.push({ binary: "ip", args });
  const rule = (...args: string[]) => commands.push({ binary: "iptables", args: ["--wait", "5", ...args] });
  // Do not reuse an existing namespace/interface/chain: failed provisioning
  // requires inspection and explicit cleanup rather than attaching to strangers.
  ip("netns", "add", namespace);
  ip("link", "add", host, "type", "veth", "peer", "name", peer);
  ip("link", "set", peer, "netns", namespace);
  ip("address", "add", `${hostAddress}/30`, "dev", host);
  ip("-n", namespace, "address", "add", `${runtimeAddress}/30`, "dev", peer);
  ip("-n", namespace, "link", "set", "lo", "up");
  rule("-N", `${chain}_OUT`);
  rule("-N", `${chain}_IN`);
  // Replies to host-initiated private proxy connections have ephemeral host
  // destination ports. This does not authorize new runtime-to-host connections.
  rule("-A", `${chain}_IN`, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT");
  // Namespace traffic can reach only the two independently provisioned private
  // browser proxies on this host. Host DNS, SSH, terminal and browser control
  // endpoints are otherwise inaccessible, regardless of their bind address.
  for (const allowed of config.proxyPorts) rule("-A", `${chain}_IN`, "-p", "tcp", "--dport", String(allowed), "-j", "ACCEPT");
  rule("-A", `${chain}_IN`, "-j", "REJECT");
  for (const service of config.localServices) rule("-A", `${chain}_OUT`, "-d", service.address, "-p", "tcp", "--dport", String(service.port), "-j", "ACCEPT");
  // Public DNS precedes the private-address block; a configured private resolver
  // is permitted only for DNS, never as a general route to the tailnet.
  for (const protocol of ["udp", "tcp"]) rule("-A", `${chain}_OUT`, "-d", config.dns, "-p", protocol, "--dport", "53", "-j", "ACCEPT");
  for (const cidr of ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"]) {
    rule("-A", `${chain}_OUT`, "-d", cidr, "-j", "REJECT");
  }
  rule("-A", `${chain}_OUT`, "-j", "ACCEPT");
  rule("-I", "INPUT", "1", "-i", host, "-j", `${chain}_IN`);
  rule("-I", "FORWARD", "1", "-i", host, "-j", `${chain}_OUT`);
  rule("-I", "FORWARD", "1", "-o", host, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT");
  rule("-I", "FORWARD", "2", "-o", host, "-j", "REJECT");
  rule("-t", "nat", "-A", "POSTROUTING", "-s", subnet, "!", "-o", host, "-j", "MASQUERADE");
  // No IPv6 interface routes; disable autoconfiguration before either end is up.
  ip("netns", "exec", namespace, "sysctl", "-q", "-w", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1");
  ip("link", "set", host, "up");
  ip("-n", namespace, "link", "set", peer, "up");
  ip("-n", namespace, "route", "add", "default", "via", hostAddress, "dev", peer);
  return commands;
}

/** Cleanup is separately requested, and removes only exact rules and names from
 * the verified provisioning record. It never flushes a host firewall table. */
export function isolationNetworkCleanup(config: IsolationNetworkConfig): IsolationNetworkCommand[] {
  validateIsolationNetwork(config);
  const host = config.hostInterface, chain = `PI_${host.toUpperCase()}`;
  const firewall: string[][] = [
    ["-D", "INPUT", "-i", host, "-j", `${chain}_IN`],
    ["-D", "FORWARD", "-i", host, "-j", `${chain}_OUT`],
    ["-D", "FORWARD", "-o", host, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ["-D", "FORWARD", "-o", host, "-j", "REJECT"],
    ["-t", "nat", "-D", "POSTROUTING", "-s", config.subnet, "!", "-o", host, "-j", "MASQUERADE"],
    ["-F", `${chain}_IN`], ["-F", `${chain}_OUT`], ["-X", `${chain}_IN`], ["-X", `${chain}_OUT`],
  ];
  return [{ binary: "ip", args: ["link", "set", host, "down"] },
    ...firewall.map(args => ({ binary: "iptables" as const, args: ["--wait", "5", ...args] })),
    { binary: "ip", args: ["link", "delete", host] }, { binary: "ip", args: ["netns", "delete", config.namespace] }];
}
