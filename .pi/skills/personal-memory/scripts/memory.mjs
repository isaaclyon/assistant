#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolveBridgeSessionDirectories,
  resolveMemoryDirectory,
  resolveMemoryGitAutocommit,
  resolveMemoryView,
} from "./config.mjs";
import { commitMemoryMutation, prepareMemoryGitAutocommit } from "./git.mjs";
import { compileCoreMemory, lintMemoryVault } from "./inspect.mjs";
import { errorEnvelope, successEnvelope } from "./protocol.mjs";
import { createMarkdownMemorySearchBackend } from "./search.mjs";
import { MemoryError, createMarkdownMemoryStore } from "./store.mjs";
import { MutationBusyError } from "../../../lib/mutation-lock.mjs";

const COMMANDS = new Set(["add", "read", "update", "delete", "search", "list", "happening-add", "happenings", "lint", "core"]);
const MAX_REQUEST_BYTES = 300 * 1024;
const USAGE_CODES = new Set(["INVALID_COMMAND", "INVALID_INPUT", "INVALID_ID"]);
const OPERATIONAL_CODES = new Set([
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "TEXT_CONFLICT",
  "DUPLICATE_ID",
  "CONFIRMATION_REQUIRED",
  "UNSAFE_VAULT",
  "UNSAFE_ENTRY",
  "MALFORMED_NOTE",
  "DUPLICATE_HAPPENING",
  "CORE_INVALID",
  "GIT_AUTOCOMMIT_UNAVAILABLE",
  "MUTATION_BUSY",
]);
const MUTATING_COMMANDS = new Set(["add", "update", "delete", "happening-add"]);
const GIT_ACTIONS = { add: "add", delete: "delete" };
// scripts/ -> personal-memory/ -> skills/ -> .pi/ -> repo root
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function readRequest(stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new MemoryError("INVALID_INPUT", "Request is too large");
    }
    chunks.push(buffer);
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text === "" || text.includes("\n")) {
    throw new MemoryError("INVALID_INPUT", "Request must be exactly one JSON line");
  }
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new MemoryError("INVALID_INPUT", "Request is not valid JSON");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new MemoryError("INVALID_INPUT", "Request must be a JSON object");
  }
  return request;
}

/** Shared CLI/tool boundary. confirmed is a trusted in-process capability,
 * never a field read from a model/CLI request. Only the Telegram approval
 * handler supplies it after consuming an operation-bound, one-use token. */
export async function executeMemoryOperation(command, request, {
  env = process.env, cwd = process.cwd(), confirmed = false,
} = {}) {
  if (!COMMANDS.has(command)) throw new MemoryError("INVALID_COMMAND", "Unknown memory operation");
  const root = resolveMemoryDirectory(env);
  const view = resolveMemoryView(env);
  const forbiddenRoots = [cwd, PROJECT_ROOT];
  const store = createMarkdownMemoryStore({ root, forbiddenRoots, ...view });
  if (MUTATING_COMMANDS.has(command)) {
    return store.withMutation(async (locked) => {
      if (!confirmed && (command === "delete" ||
          (command === "update" && request?.patch?.scope === "household" &&
           (await locked.read({ id: request.id })).scope === "personal"))) {
        throw new MemoryError("CONFIRMATION_REQUIRED", "Use the memory tool's Telegram confirmation button");
      }
      const gitRoot = resolveMemoryGitAutocommit(env)
        ? await prepareMemoryGitAutocommit(root, { env }) : undefined;
      const operation = command === "happening-add" ? "addHappening"
        : command === "delete" && gitRoot ? "deleteWithLocation" : command;
      const result = await locked[operation](request);
      if (!gitRoot) return result;
      const { relativePath, ...publicData } = result;
      return {
        ...publicData,
        git: await commitMemoryMutation(gitRoot, {
          action: GIT_ACTIONS[command] ?? "update", id: result.id, relativePath,
        }, { env }),
      };
    });
  }
  if (command === "lint" || command === "core") {
    if (Object.keys(request).length > 0) throw new MemoryError("INVALID_INPUT", "Request must be empty");
    const options = { root, forbiddenRoots, sessionRoots: resolveBridgeSessionDirectories(env), ...view };
    return command === "lint" ? lintMemoryVault(options) : compileCoreMemory(options);
  }
  if (command === "search" || command === "happenings") {
    await store.verifyRoot();
    return createMarkdownMemorySearchBackend({ root, ...view })[command](request);
  }
  if (command === "list") return { memories: await store.list(request) };
  return store[command](request);
}

export async function runMemoryCli({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const emitError = (code, message) => {
    stderr.write(`${JSON.stringify(errorEnvelope(code, message))}\n`);
    if (USAGE_CODES.has(code)) return 2;
    if (OPERATIONAL_CODES.has(code)) return 3;
    return 1;
  };

  const command = argv[0];
  if (argv.length !== 1 || !COMMANDS.has(command)) {
    return emitError(
      "INVALID_COMMAND",
      "Usage: memory.mjs <add|read|update|delete|search|list|happening-add|happenings|lint|core> with one JSON request line on stdin",
    );
  }

  let request;
  try {
    request = await readRequest(stdin);
  } catch (error) {
    if (error instanceof MemoryError) return emitError(error.code, error.message);
    return emitError("IO_ERROR", "Request could not be read");
  }

  try {
    const data = await executeMemoryOperation(command, request, { env, cwd });
    stdout.write(`${JSON.stringify(successEnvelope(data))}\n`);
    return command === "lint" && !data.valid ? 3 : 0;
  } catch (error) {
    if (error instanceof MemoryError || error instanceof MutationBusyError) return emitError(error.code, error.message);
    return emitError("IO_ERROR", "Memory storage is unavailable");
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  process.exitCode = await runMemoryCli();
}
