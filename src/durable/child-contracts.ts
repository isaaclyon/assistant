import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

export const CHILD_TIMEOUT_MS = 30 * 60_000;
export const CHILD_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const CHILD_REPORT_BYTES = 64 * 1024;
export type ChildIdentity = { batchId: string; jobId: string; launchId: string };
/** Private task configuration; never used as main Harness task input. */
export type ChildManifest = ChildIdentity & {
  version: 1;
  purpose: string;
  createdAt: number;
  expiresAt: number;
  deadlineAt: number;
  endCondition: string;
  task: string;
  context: string;
  model: { provider: string; modelId: string };
  thinkingLevel: ModelThinkingLevel;
  roots: string[];
  workspaceCwd: string;
  provider: { credentialPath: string; settingsPath: string; account: string; credentialFormat?: 'pi-auth' | 'native' };
};
export type ChildOutcome = ChildIdentity & {
  version: 1;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  output: string;
  finishedAt: number;
};
export function boundedChildText(value: string): string {
  if (Buffer.byteLength(value) <= CHILD_REPORT_BYTES) return value;
  const suffix = '\n[Report truncated at 64 KiB]';
  let text = Buffer.from(value).subarray(0, CHILD_REPORT_BYTES - Buffer.byteLength(suffix)).toString('utf8');
  if (text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return text + suffix;
}
