#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { errorEnvelope } from "./protocol.mjs";

export async function runMemoryCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const command = argv[0];
  if (!command) {
    stderr.write(`${JSON.stringify(errorEnvelope("INVALID_COMMAND", "A command is required"))}\n`);
    return 2;
  }

  stderr.write(`${JSON.stringify(errorEnvelope("INVALID_COMMAND", "Command is not implemented"))}\n`);
  return 2;
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  process.exitCode = await runMemoryCli();
}
