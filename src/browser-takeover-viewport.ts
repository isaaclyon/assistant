export interface TakeoverViewport { width: number; height: number; desktop: boolean }

export function validTakeoverViewport(value: unknown): value is TakeoverViewport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && typeof v.desktop === "boolean" &&
    Number.isInteger(v.width) && Number(v.width) >= 320 && Number(v.width) <= 1920 &&
    Number.isInteger(v.height) && Number(v.height) >= 180 && Number(v.height) <= 1080;
}
