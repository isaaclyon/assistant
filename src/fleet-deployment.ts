export interface FleetRuntimeIdentity {
  instanceId: string;
  releaseSha: string;
  pid: number;
}

export interface BridgeFleetDeploymentAdapter {
  preflight(targetSha: string, instanceIds: readonly string[]): Promise<unknown>;
  buildRelease(targetSha: string): Promise<unknown>;
  activate(instanceId: string, targetSha: string): Promise<unknown>;
  waitUntilReady(
    instanceId: string,
    targetSha: string,
  ): Promise<FleetRuntimeIdentity>;
  rollback(instanceId: string, previousSha: string): Promise<unknown>;
}

export interface BridgeFleetDeploymentOptions {
  instanceIds: readonly string[];
  targetSha: string;
  previousSha: string;
  adapter: BridgeFleetDeploymentAdapter;
}

export interface BridgeFleetDeploymentResult {
  releaseSha: string;
  instances: FleetRuntimeIdentity[];
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function assertDeploymentInput(options: BridgeFleetDeploymentOptions): void {
  if (!SHA_PATTERN.test(options.targetSha) || !SHA_PATTERN.test(options.previousSha)) {
    throw new Error("Fleet deployment requires full 40-character release SHAs");
  }
  if (options.instanceIds.length === 0) {
    throw new Error("Fleet deployment requires at least one configured instance");
  }
  if (new Set(options.instanceIds).size !== options.instanceIds.length) {
    throw new Error("Fleet deployment instance IDs must be unique");
  }
}

export async function deployBridgeFleet(
  options: BridgeFleetDeploymentOptions,
): Promise<BridgeFleetDeploymentResult> {
  assertDeploymentInput(options);
  await options.adapter.preflight(options.targetSha, options.instanceIds);
  await options.adapter.buildRelease(options.targetSha);

  const changed: string[] = [];
  const ready: FleetRuntimeIdentity[] = [];
  try {
    for (const instanceId of options.instanceIds) {
      changed.push(instanceId);
      await options.adapter.activate(instanceId, options.targetSha);
      const identity = await options.adapter.waitUntilReady(
        instanceId,
        options.targetSha,
      );
      if (
        identity.instanceId !== instanceId ||
        identity.releaseSha !== options.targetSha ||
        !Number.isSafeInteger(identity.pid) ||
        identity.pid <= 0
      ) {
        throw new Error(`Runtime readiness identity is invalid for ${instanceId}`);
      }
      ready.push(identity);
    }
  } catch (activationError) {
    const rollbackErrors: string[] = [];
    for (const instanceId of changed.reverse()) {
      try {
        await options.adapter.rollback(instanceId, options.previousSha);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${instanceId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length > 0) {
      const activationMessage =
        activationError instanceof Error
          ? activationError.message
          : String(activationError);
      throw new Error(
        `Fleet activation failed: ${activationMessage}; rollback failed: ${rollbackErrors.join("; ")}`,
        { cause: activationError },
      );
    }
    throw activationError;
  }

  return { releaseSha: options.targetSha, instances: ready };
}
