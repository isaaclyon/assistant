import type { RenderedInstanceServiceUnit } from "./service-unit.js";

export interface IsolationSupportUnitOptions {
  instanceId: string;
  nodePath: string;
  releasePath: string;
  namespace: string;
  networkConfigPath: string;
  endpointConfigPath: string;
  brokerConfigPath: string;
  brokerHome: string;
  brokerUser: string;
  runtimeGroup: string;
}

export function renderIsolationSupportUnits(options: IsolationSupportUnitOptions): RenderedInstanceServiceUnit[] {
  const { instanceId, namespace, brokerUser, runtimeGroup, brokerHome, nodePath, releasePath } = options;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(instanceId) || !/^pi-[a-z0-9-]{1,24}$/.test(namespace) ||
      [brokerUser, runtimeGroup].some(name => !/^[a-z_][a-z0-9_-]{0,30}$/.test(name) || ["root", "sudo", "docker", "lxd", "wheel", "adm"].includes(name)) ||
      !/^\/var\/lib\/[a-z][a-z0-9_-]*$/.test(brokerHome)) throw new Error("Invalid isolation support identity");
  for (const path of [nodePath, releasePath, options.networkConfigPath, options.endpointConfigPath, options.brokerConfigPath]) {
    if (!/^\/(?:opt|etc|usr)\/[a-zA-Z0-9/_.-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Invalid isolation support path");
  }
  const networkName = `pi-isolated-network-${namespace}.service`;
  const base = `[Unit]\nWants=network-online.target\nAfter=network-online.target\n`;
  const program = (name: string) => `"${nodePath}" "${releasePath}/dist/src/${name}.js"`;
  return [
    { unitName: networkName, contents: `${base}Description=Isolated assistant network\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${program("isolation-network-service")} start "${options.networkConfigPath}"\nExecStop=${program("isolation-network-service")} stop "${options.networkConfigPath}"\nTimeoutStartSec=90s\nTimeoutStopSec=90s\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n` },
    { unitName: `pi-trusted-broker-${instanceId}.service`, contents: `${base}Description=Trusted assistant credential and Telegram broker\n\n[Service]\nType=simple\nUser=${brokerUser}\nGroup=${runtimeGroup}\nSupplementaryGroups=\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nAmbientCapabilities=\nProtectSystem=strict\nProtectHome=yes\nProtectProc=invisible\nPrivateTmp=yes\nRestrictSUIDSGID=yes\nRuntimeDirectory=pi-broker-${instanceId}\nRuntimeDirectoryMode=0750\nReadWritePaths=${brokerHome}\nEnvironment="HOME=${brokerHome}"\nExecCondition=${program("recovery-start-check")} "${brokerHome}"\nExecStart=${program("trusted-broker-daemon")} "${options.brokerConfigPath}"\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=45s\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n` },
    ...(["input", "takeover"] as const).map(kind => ({ unitName: `pi-private-${kind}-${instanceId}.service`,
      contents: `${base}Description=Private assistant browser proxy\nRequires=${networkName}\nAfter=${networkName} tailscaled.service\n\n[Service]\nType=simple\nExecStart=${program("isolation-proxy-service")} "${options.endpointConfigPath}" ${kind}\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=15s\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n` })),
  ];
}
