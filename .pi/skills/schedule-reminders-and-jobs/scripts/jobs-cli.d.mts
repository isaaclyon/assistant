export interface JobsCliEnvironment {
  PI_TELEGRAM_JOBS_DIR?: string;
  PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST?: string;
  PI_TELEGRAM_BRIDGE_STATE_ROOT?: string;
  PI_TELEGRAM_BRIDGE_STATE_DIR?: string;
}

export interface ApplyJobsRequestOptions {
  stateDir?: string;
  env?: JobsCliEnvironment;
  now?: () => number;
  validateReload?: boolean;
  reloadTimeoutMs?: number;
}

export function resolveCoordinatorStateDir(
  env?: JobsCliEnvironment,
): Promise<string>;

export function applyJobsRequest(
  input: Record<string, unknown>,
  options?: ApplyJobsRequestOptions,
): Promise<Record<string, unknown>>;
