/** Per-instance operational switches. These never grant capabilities or memory access. */
export const FEATURE_FLAGS = {
  PI_TELEGRAM_MEMORY_RECALL: { enabledValue: "jev", defaultEnabled: false },
  PI_TELEGRAM_SESSION_ROUTING: { enabledValue: "jev", defaultEnabled: false },
  // Preserve existing installations: the embedding key is still required.
  PI_TELEGRAM_MEMORY_SEMANTIC: { enabledValue: "on", defaultEnabled: true },
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export function isFeatureFlag(key: string): key is FeatureFlag {
  return Object.hasOwn(FEATURE_FLAGS, key);
}

export function isFeatureEnabled(
  key: FeatureFlag,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const flag = FEATURE_FLAGS[key];
  const value = env[key]?.trim();
  if (value === undefined) return flag.defaultEnabled;
  if (value === "off") return false;
  if (value === flag.enabledValue) return true;
  throw new Error(`${key} must be ${flag.enabledValue} or off`);
}
