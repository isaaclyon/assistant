import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PASSWORD_BYTES = 4 * 1024;
const FAILURE_MESSAGE = "Google Workspace command failed";

interface GoogleRuntime {
  account?: string;
  binary?: string;
  passwordFile?: string;
  gogHome?: string;
}

interface GoogleToolDetails {
  ok: boolean;
  result: unknown;
  error: { code: string; message: string } | null;
}

interface GoogleWorkspaceRegistrationOptions {
  resolveRuntime(): Promise<GoogleRuntime>;
  run(args: string[], signal?: AbortSignal): Promise<unknown>;
}

interface MinimalPiApi {
  registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]): void;
}

function success(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: GoogleToolDetails;
} {
  const details = { ok: true, result, error: null } satisfies GoogleToolDetails;
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function failure(code: string, message: string): {
  content: Array<{ type: "text"; text: string }>;
  details: GoogleToolDetails;
} {
  const details = {
    ok: false,
    result: null,
    error: { code, message },
  } satisfies GoogleToolDetails;
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
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

async function readPrivatePassword(path: string): Promise<string> {
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

export async function runGogJson(options: {
  binary: string;
  passwordFile: string;
  gogHome: string;
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<unknown> {
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
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      reject(new Error(FAILURE_MESSAGE));
    };
    const abort = () => fail();
    const child = spawn(options.binary, options.args, {
      env: selectedEnvironment(password, options.gogHome),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
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
      if (code !== 0) return fail();
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        settled = true;
        resolve(parsed);
      } catch {
        fail();
      }
    });
  });
}

export async function resolveGoogleRuntime(): Promise<GoogleRuntime> {
  const binary = process.env.PI_TELEGRAM_GOG_BINARY?.trim();
  const passwordFile = process.env.PI_TELEGRAM_GOG_KEYRING_PASSWORD_FILE?.trim();
  const gogHome = process.env.PI_TELEGRAM_GOG_HOME?.trim();
  const account = process.env.PI_TELEGRAM_GOOGLE_ACCOUNT?.trim();
  if (
    !binary ||
    !isAbsolute(binary) ||
    !passwordFile ||
    !isAbsolute(passwordFile) ||
    !gogHome ||
    !isAbsolute(gogHome)
  ) {
    throw new Error("Google Workspace runtime is unavailable");
  }
  return { binary, passwordFile, gogHome, ...(account ? { account } : {}) };
}

function parseAccountStatus(payload: unknown, account: string): {
  operation: "account_status";
  account: string;
  authenticated: boolean;
  services: string[];
} {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { accounts?: unknown }).accounts)) {
    throw new Error(FAILURE_MESSAGE);
  }
  const match = (payload as { accounts: unknown[] }).accounts.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    return (candidate as { email?: unknown }).email?.toString().toLowerCase() === account.toLowerCase();
  });
  if (!match || typeof match !== "object") {
    return { operation: "account_status", account, authenticated: false, services: [] };
  }
  const services = Array.isArray((match as { services?: unknown }).services)
    ? (match as { services: unknown[] }).services
        .filter((service): service is string => typeof service === "string")
        .filter((service) => service.length <= 64)
        .sort()
        .slice(0, 32)
    : [];
  return { operation: "account_status", account, authenticated: true, services };
}

export function registerGoogleWorkspaceTool(
  pi: MinimalPiApi,
  options: GoogleWorkspaceRegistrationOptions,
): void {
  pi.registerTool({
    name: "google_workspace",
    label: "Google Workspace",
    description:
      "Run typed, allowlisted Google Workspace operations. The foundation currently exposes only a non-sensitive account authentication status check.",
    promptSnippet: "Inspect configured Google Workspace account status through an allowlisted operation",
    promptGuidelines: [
      "Use google_workspace only for its typed operations; never attempt to invoke gogcli through shell commands.",
    ],
    parameters: Type.Object(
      {
        operation: StringEnum(["account_status"] as const),
        account: Type.Optional(Type.String({ minLength: 3, maxLength: 254 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      const input = params as { operation: "account_status"; account?: string };
      let runtime: GoogleRuntime;
      try {
        runtime = await options.resolveRuntime();
      } catch {
        return failure("GOOGLE_WORKSPACE_UNAVAILABLE", "Google Workspace is temporarily unavailable");
      }
      const account = input.account?.trim() || runtime.account?.trim();
      if (!account) {
        return failure(
          "GOOGLE_ACCOUNT_REQUIRED",
          "Choose a Google account or configure a default account",
        );
      }
      if (/[\r\n\0]/.test(account)) {
        return failure("GOOGLE_ACCOUNT_INVALID", "The Google account is invalid");
      }
      try {
        const payload = await options.run(
          [
            "--no-input",
            "--readonly",
            "--gmail-no-send",
            "--wrap-untrusted",
            "--json",
            "--account",
            account,
            "auth",
            "list",
          ],
          signal,
        );
        return success(parseAccountStatus(payload, account));
      } catch {
        return failure("GOOGLE_WORKSPACE_UNAVAILABLE", "Google Workspace is temporarily unavailable");
      }
    },
  });
}

export default function googleWorkspaceExtension(pi: ExtensionAPI): void {
  registerGoogleWorkspaceTool(pi, {
    resolveRuntime: resolveGoogleRuntime,
    async run(args, signal) {
      const runtime = await resolveGoogleRuntime();
      return await runGogJson({
        binary: runtime.binary!,
        passwordFile: runtime.passwordFile!,
        gogHome: runtime.gogHome!,
        args,
        ...(signal ? { signal } : {}),
      });
    },
  });
}
