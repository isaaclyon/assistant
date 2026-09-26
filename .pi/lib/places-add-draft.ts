import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// A direct add flow holds the place name and chosen category before an
// insertion exists. Persisting it lets the flow survive a session reset.
export type AddDraft = { name: string; categoryId?: string };

export const ADD_DRAFT_FILE = "places-add-draft.json";
const MAX_DRAFT_BYTES = 4 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 256;
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1_000;

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/.test(value);
}

function validDraft(draft: { name?: unknown; categoryId?: unknown }): boolean {
  return validText(draft.name, MAX_NAME_LENGTH) &&
    (draft.categoryId === undefined || validText(draft.categoryId, MAX_CATEGORY_LENGTH));
}

/** Returns the saved draft, or undefined when it is missing, expired, or malformed. */
export function readAddDraft(path: string, now = Date.now()): AddDraft | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_DRAFT_BYTES) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const saved = value as Record<string, unknown>;
    if (
      saved.version !== 1 || !Number.isSafeInteger(saved.savedAt) ||
      (saved.savedAt as number) > now || now - (saved.savedAt as number) > MAX_DRAFT_AGE_MS ||
      !validDraft(saved)
    ) {
      return undefined;
    }
    return {
      name: saved.name as string,
      ...(saved.categoryId === undefined ? {} : { categoryId: saved.categoryId as string }),
    };
  } catch {
    return undefined;
  }
}

/** Atomically saves the draft with mode 0600, or removes the file when the draft is cleared. */
export function persistAddDraft(path: string, draft: AddDraft | undefined, now = Date.now()): void {
  if (!draft) {
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  if (!validDraft(draft)) throw new Error("The add draft is invalid.");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, savedAt: now, ...draft })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* keep the original error */ }
    throw error;
  }
}
