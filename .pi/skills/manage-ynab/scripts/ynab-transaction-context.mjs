#!/usr/bin/env node

import { transactionContext } from "./ynab-read.mjs";

if (process.argv.length !== 3) {
  process.stderr.write("Usage: ynab-transaction-context.mjs <transaction-id>\n");
  process.exitCode = 2;
} else {
  try {
    const context = await transactionContext(process.argv[2]);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...context })}\n`);
  } catch {
    process.stderr.write("Could not read YNAB transaction context.\n");
    process.exitCode = 1;
  }
}
