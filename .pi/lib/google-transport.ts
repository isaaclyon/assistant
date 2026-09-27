import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { parseCalendarWriteConfig, type CalendarWriteConfig } from "./google-calendar-writes.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PASSWORD_BYTES = 4 * 1024;
export const FAILURE_MESSAGE = "Google Workspace command failed";
const MAX_PLACES_MONTHLY_LIMIT = 1_000_000;

export interface GoogleRuntime {
  calendarWrites?: CalendarWriteConfig;
  account?: string;
  binary?: string;
  passwordFile?: string;
  gogHome?: string;
  stateDir?: string;
  placesApiKeyFile?: string;
  placesSearchMonthlyLimit?: number;
  placesDetailsMonthlyLimit?: number;
  placesCandidatesMonthlyLimit?: number;
}

function selectedEnvironment(password: string, gogHome: string): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? homedir(),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
    GOG_KEYRING_PASSWORD: password,
    GOG_HOME: gogHome,
  };
  for (const key of ["LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    const value = process.env[key];
    if (value) selected[key] = value;
  }
  return selected;
}

export async function readPrivatePassword(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(FAILURE_MESSAGE);
  const metadata = await stat(path);
  const currentUid = process.getuid?.();
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size < 1 ||
    metadata.size > MAX_PASSWORD_BYTES ||
    (currentUid !== undefined && metadata.uid !== currentUid)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const password = (await readFile(path, "utf8")).trim();
  if (!password) throw new Error(FAILURE_MESSAGE);
  return password;
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new Error(FAILURE_MESSAGE);
  if (!response.body) throw new Error(FAILURE_MESSAGE);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(FAILURE_MESSAGE);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function runGogJson(options: {
  binary: string;
  passwordFile: string;
  gogHome: string;
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowEmptyOutput?: boolean;
}): Promise<unknown> {
  try {
    if (options.signal?.aborted) throw new Error(FAILURE_MESSAGE);
    if (!isAbsolute(options.binary) || !isAbsolute(options.gogHome)) {
      throw new Error(FAILURE_MESSAGE);
    }
    await access(options.binary, constants.X_OK);
    const password = await readPrivatePassword(options.passwordFile);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new Error(FAILURE_MESSAGE);
    }

    return await new Promise<unknown>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error(FAILURE_MESSAGE)); return; }
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        killChildTree();
        reject(new Error(FAILURE_MESSAGE));
      };
      const abort = () => fail();
      const child = spawn(options.binary, options.args, {
        env: selectedEnvironment(password, options.gogHome),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      const killChildTree = () => {
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* direct-child fallback */ }
        }
        child.kill("SIGKILL");
      };
      const timer = setTimeout(fail, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        fail();
        return;
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) return fail();
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) fail();
      });
      child.once("error", fail);
      child.once("close", (code) => {
        if (settled) return;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (code !== 0 || stderrBytes > 0) return fail();
        try {
          const output = Buffer.concat(stdout).toString("utf8");
          const parsed: unknown = options.allowEmptyOutput && !output.trim() ? {} : JSON.parse(output);
          killChildTree();
          settled = true;
          resolve(parsed);
        } catch {
          fail();
        }
      });
    });
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }
}

export async function resolveGoogleRuntime(): Promise<GoogleRuntime> {
  const calendarWrites = parseCalendarWriteConfig(process.env.PI_TELEGRAM_GOOGLE_CALENDAR_WRITES, process.env.PI_TELEGRAM_BRIDGE_INSTANCE_ID);
  const binary = process.env.PI_TELEGRAM_GOG_BINARY?.trim();
  const passwordFile = process.env.PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE?.trim();
  const gogHome = process.env.PI_TELEGRAM_GOG_HOME?.trim();
  const account = process.env.PI_TELEGRAM_GOOGLE_ACCOUNT?.trim();
  const stateDir = process.env.PI_TELEGRAM_BRIDGE_STATE_DIR?.trim();
  const placesApiKeyFile = process.env.PI_TELEGRAM_GOOGLE_PLACES_API_KEY_FILE?.trim();
  const placesSearchMonthlyLimit = monthlyPlacesLimit(
    process.env.PI_TELEGRAM_GOOGLE_PLACES_SEARCH_MONTHLY_LIMIT,
  );
  const placesDetailsMonthlyLimit = monthlyPlacesLimit(
    process.env.PI_TELEGRAM_GOOGLE_PLACES_DETAILS_MONTHLY_LIMIT,
  );
  const placesCandidatesMonthlyLimit = monthlyPlacesLimit(
    process.env.PI_TELEGRAM_GOOGLE_PLACES_CANDIDATES_MONTHLY_LIMIT,
  );
  const gogConfigured = Boolean(
    binary && isAbsolute(binary) &&
    passwordFile && isAbsolute(passwordFile) &&
    gogHome && isAbsolute(gogHome),
  );
  return {
    ...(calendarWrites ? { calendarWrites } : {}),
    ...(gogConfigured ? { binary: binary!, passwordFile: passwordFile!, gogHome: gogHome! } : {}),
    ...(account ? { account } : {}),
    ...(stateDir && isAbsolute(stateDir) ? { stateDir } : {}),
    ...(placesApiKeyFile && isAbsolute(placesApiKeyFile) ? { placesApiKeyFile } : {}),
    ...(placesSearchMonthlyLimit === undefined ? {} : { placesSearchMonthlyLimit }),
    ...(placesDetailsMonthlyLimit === undefined ? {} : { placesDetailsMonthlyLimit }),
    ...(placesCandidatesMonthlyLimit === undefined ? {} : { placesCandidatesMonthlyLimit }),
  };
}

/** Workspace operations need all three gog settings; Places needs none. */
export function hasGogRuntime(
  runtime: GoogleRuntime,
): runtime is GoogleRuntime & { binary: string; passwordFile: string; gogHome: string } {
  return Boolean(runtime.binary && runtime.passwordFile && runtime.gogHome);
}

function monthlyPlacesLimit(value: string | undefined): number | undefined {
  const selected = value?.trim();
  if (!selected || !/^\d+$/.test(selected)) return undefined;
  const parsed = Number(selected);
  return Number.isSafeInteger(parsed) && parsed <= MAX_PLACES_MONTHLY_LIMIT ? parsed : undefined;
}
