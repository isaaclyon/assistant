import {
  loadBridgeInstanceManifest,
  type BridgeInstanceDefinition,
} from "./instances.js";
import { sendTelegramNotification } from "./telegram-notification.js";

export interface FleetDeploymentNotificationOptions {
  manifestPath: string;
  agentDir: string;
  releaseSha: string;
  fetchImpl?: typeof fetch;
}

export interface FleetDeploymentNotificationResult {
  coordinatorId: string;
  instanceCount: number;
}

function requireReleaseSha(value: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("Deployment notification requires a full release SHA.");
  }
  return value;
}

function selectCoordinator(instances: BridgeInstanceDefinition[]): BridgeInstanceDefinition {
  const coordinator = instances.find((instance) => instance.jobsRole === "coordinator");
  if (!coordinator) {
    throw new Error("Deployment notification requires a fleet coordinator.");
  }
  return coordinator;
}

export async function notifyFleetDeployment({
  manifestPath,
  agentDir,
  releaseSha,
  fetchImpl,
}: FleetDeploymentNotificationOptions): Promise<FleetDeploymentNotificationResult> {
  const sha = requireReleaseSha(releaseSha);
  const manifest = await loadBridgeInstanceManifest(manifestPath);
  const coordinator = selectCoordinator(manifest.instances);
  const instanceCount = manifest.instances.length;
  await sendTelegramNotification({
    agentDir,
    telegramProfile: coordinator.telegramProfile,
    telegramSurface: coordinator.telegramSurface,
    text: `✅ Deployment complete: ${sha.slice(0, 7)}. All ${instanceCount} bridge instances are ready.`,
    failureLabel: "Telegram deployment notification",
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { coordinatorId: coordinator.id, instanceCount };
}
