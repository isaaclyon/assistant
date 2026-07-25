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
  targetInstanceId: string;
  instanceCount: number;
}

function requireReleaseSha(value: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("Deployment notification requires a full release SHA.");
  }
  return value;
}

function selectNotificationTarget(
  instances: BridgeInstanceDefinition[],
): BridgeInstanceDefinition {
  const targets = instances.filter((instance) => instance.principal === "engineering");
  if (targets.length !== 1) {
    throw new Error(
      "Deployment notification requires exactly one engineering instance.",
    );
  }
  return targets[0]!;
}

export async function notifyFleetDeployment({
  manifestPath,
  agentDir,
  releaseSha,
  fetchImpl,
}: FleetDeploymentNotificationOptions): Promise<FleetDeploymentNotificationResult> {
  const sha = requireReleaseSha(releaseSha);
  const manifest = await loadBridgeInstanceManifest(manifestPath);
  const target = selectNotificationTarget(manifest.instances);
  const instanceCount = manifest.instances.length;
  await sendTelegramNotification({
    agentDir,
    telegramProfile: target.telegramProfile,
    telegramSurface: target.telegramSurface,
    text: `✅ Deployment complete: ${sha.slice(0, 7)}. All ${instanceCount} bridge instances are ready.`,
    failureLabel: "Telegram deployment notification",
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { targetInstanceId: target.id, instanceCount };
}
