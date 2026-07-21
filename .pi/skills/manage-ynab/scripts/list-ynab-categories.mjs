#!/usr/bin/env node

import { listCategories } from "./ynab-read.mjs";

try {
  const categories = await listCategories();
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, categories })}\n`);
} catch {
  process.stderr.write("Could not list YNAB categories.\n");
  process.exitCode = 1;
}
