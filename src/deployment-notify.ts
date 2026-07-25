import { notifyFleetDeployment } from "./deployment-notification.js";

const [manifestPath, agentDir, releaseSha] = process.argv.slice(2);
if (!manifestPath || !agentDir || !releaseSha) {
  throw new Error(
    "Usage: deployment-notify <instance-manifest> <Pi-agent-directory> <release-sha>",
  );
}

const result = await notifyFleetDeployment({ manifestPath, agentDir, releaseSha });
console.log(
  `Sent deployment notification through instance ${result.targetInstanceId}.`,
);
