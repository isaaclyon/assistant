import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { HeartbeatObservationV1 } from "../heartbeat.js";

const execFileAsync = promisify(execFile);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OVERDUE_TRANSACTIONS = 50;

export function cutoffDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  const cutoff = new Date(Date.UTC(value("year"), value("month") - 1, value("day") - 5));
  return cutoff.toISOString().slice(0, 10);
}

export function parseOverdueUnapprovedIds(value: unknown, cutoff: string): string[] {
  if (!Array.isArray(value) || !DATE_PATTERN.test(cutoff)) {
    throw new Error("YNAB returned invalid transaction data");
  }

  const ids: string[] = [];
  for (const transaction of value) {
    if (
      typeof transaction !== "object" ||
      transaction === null ||
      !("id" in transaction) ||
      typeof transaction.id !== "string" ||
      transaction.id.length === 0 ||
      !("date" in transaction) ||
      typeof transaction.date !== "string" ||
      !DATE_PATTERN.test(transaction.date) ||
      !("approved" in transaction) ||
      typeof transaction.approved !== "boolean" ||
      !("deleted" in transaction) ||
      typeof transaction.deleted !== "boolean"
    ) {
      throw new Error("YNAB returned an invalid transaction");
    }
    if (!transaction.approved && !transaction.deleted && transaction.date <= cutoff) {
      ids.push(transaction.id);
    }
  }
  if (ids.length > MAX_OVERDUE_TRANSACTIONS) {
    throw new Error(`YNAB returned more than ${MAX_OVERDUE_TRANSACTIONS} overdue transactions`);
  }
  return ids.sort();
}

async function configuredBudgetId(): Promise<string> {
  const path = join(homedir(), ".config", "pi-telegram-bridge", "ynab.json");
  const config: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof config !== "object" ||
    config === null ||
    !("budget_id" in config) ||
    typeof config.budget_id !== "string" ||
    config.budget_id.length === 0
  ) {
    throw new Error("YNAB budget_id is not configured");
  }
  return config.budget_id;
}

async function main(): Promise<void> {
  const cutoff = cutoffDate();
  const bunBin = join(homedir(), ".bun", "bin");
  const { stdout } = await execFileAsync(
    join(bunBin, "ynab"),
    [
      "transactions",
      "list",
      "--budget",
      await configuredBudgetId(),
      "--until",
      cutoff,
      "--approved",
      "false",
      "--fields",
      "id,date,approved,deleted",
      "--compact",
    ],
    {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${bunBin}:${process.env.PATH ?? ""}` },
    },
  );
  const ids = parseOverdueUnapprovedIds(JSON.parse(stdout), cutoff);
  const observation = {
    version: 1,
    value: ids,
    display: `${ids.length} unapproved transaction${ids.length === 1 ? "" : "s"} at least 5 days old`,
    context: { cutoffDate: cutoff, count: ids.length },
  } satisfies HeartbeatObservationV1;
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`YNAB unapproved check failed: ${message.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
