import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { MemoryError } from "./store.mjs";

const execFileAsync = promisify(execFile);

function unavailable() {
  throw new MemoryError(
    "GIT_AUTOCOMMIT_UNAVAILABLE",
    "Memory Git auto-commit is unavailable",
  );
}

function safeGitEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

async function git(root, args, { env, timeoutMs = 10_000 }) {
  return execFileAsync("git", [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    ...args,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...safeGitEnvironment(env),
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    timeout: timeoutMs,
  });
}

/** ADR-0018: require an exact-root, clean-index worktree before mutation. */
export async function prepareMemoryGitAutocommit(root, options = {}) {
  const gitOptions = { env: options.env ?? process.env, timeoutMs: options.timeoutMs };
  try {
    const canonicalRoot = await realpath(root);
    const { stdout } = await git(canonicalRoot, ["rev-parse", "--show-toplevel"], gitOptions);
    const gitRoot = await realpath(stdout.trim());
    if (gitRoot !== canonicalRoot) unavailable();
    await git(canonicalRoot, ["diff", "--cached", "--quiet", "--exit-code"], gitOptions);
    return canonicalRoot;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    unavailable();
  }
}

/** Stable, injection-free identifier for an operation's commit trailer. */
export function memoryOperationTrailer(operationKey) {
  if (!/^[0-9a-f]{64}$/.test(operationKey)) unavailable();
  return `Memory-Operation: ${operationKey}`;
}

/** Commit only one trusted store-produced path; never push or include other paths.
 * An optional operationKey adds a trailer so a lost acknowledgement can be found
 * again without creating a second commit. */
export async function commitMemoryMutation(root, { action, id, relativePath, operationKey }, options = {}) {
  const gitOptions = { env: options.env ?? process.env, timeoutMs: options.timeoutMs };
  try {
    await git(root, ["add", "-A", "--", relativePath], gitOptions);
    await git(root, [
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "--only",
      "-m",
      `memory: ${action} ${id}`,
      ...(operationKey ? ["-m", memoryOperationTrailer(operationKey)] : []),
      "--",
      relativePath,
    ], gitOptions);
    return { committed: true };
  } catch {
    return { committed: false, code: "GIT_COMMIT_FAILED" };
  }
}

/** Read-only view used to reconcile one operation's optional Git commit. */
export async function inspectMemoryGitOperation(root, { relativePath, operationKey }, options = {}) {
  const gitOptions = { env: options.env ?? process.env, timeoutMs: options.timeoutMs };
  try {
    const log = await git(root, [
      "log", "-n", "1", "--fixed-strings", `--grep=${memoryOperationTrailer(operationKey)}`, "--format=%H",
    ], gitOptions).catch((error) => {
      // An unborn branch has no history and therefore no matching commit.
      if (/does not have any commits yet/.test(String(error?.stderr))) return { stdout: "" };
      throw error;
    });
    const status = await git(root, ["status", "--porcelain", "--", relativePath], gitOptions);
    const staged = await git(root, ["diff", "--cached", "--name-only", "-z"], gitOptions);
    const stagedPaths = staged.stdout.split("\0").filter(Boolean);
    return {
      committed: log.stdout.trim() !== "",
      pathDirty: status.stdout.trim() !== "",
      otherStaged: stagedPaths.some((path) => path !== relativePath),
    };
  } catch {
    unavailable();
  }
}
