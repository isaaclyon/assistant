import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CATEGORIES = 300;
const MAX_RECENT = 5;

export function flattenActiveCategories(groups) {
  if (!Array.isArray(groups)) throw new Error("YNAB returned invalid categories");
  const categories = groups.flatMap((group) => {
    if (!group || typeof group !== "object" || group.deleted || group.hidden) return [];
    if (typeof group.name !== "string" || !Array.isArray(group.categories)) return [];
    return group.categories.flatMap((category) => {
      if (!category || typeof category !== "object" || category.deleted || category.hidden) return [];
      if (typeof category.id !== "string" || typeof category.name !== "string") return [];
      return [{ id: category.id, name: category.name, group: group.name }];
    });
  });
  if (categories.length > MAX_CATEGORIES) throw new Error("YNAB returned too many categories");
  return categories.sort((a, b) =>
    a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
  );
}

export function summarizeTransactionContext(transaction, history) {
  if (
    !transaction ||
    typeof transaction !== "object" ||
    typeof transaction.id !== "string" ||
    typeof transaction.payee_name !== "string" ||
    !Array.isArray(history)
  ) {
    throw new Error("YNAB returned invalid transaction context");
  }

  const exact = history
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        entry.id !== transaction.id &&
        entry.payee_name === transaction.payee_name &&
        entry.deleted !== true,
    )
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  const counts = new Map();
  for (const entry of exact) {
    if (
      typeof entry.category_name === "string" &&
      entry.category_name !== "Uncategorized"
    ) {
      counts.set(entry.category_name, (counts.get(entry.category_name) ?? 0) + 1);
    }
  }

  return {
    transaction: {
      id: transaction.id,
      date: transaction.date ?? null,
      amount: transaction.amount ?? null,
      payee: transaction.payee_name,
      category: transaction.category_name ?? null,
      account: transaction.account_name ?? null,
      memo: transaction.memo ?? null,
      approved: transaction.approved ?? null,
    },
    exactPayeeHistory: {
      transactionCount: exact.length,
      categoryCounts: [...counts.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      recent: exact.slice(0, MAX_RECENT).map((entry) => ({
        date: entry.date ?? null,
        amount: entry.amount ?? null,
        category: entry.category_name ?? null,
      })),
    },
  };
}

async function budgetId() {
  const config = JSON.parse(
    await readFile(join(homedir(), ".config", "pi-telegram-bridge", "ynab.json"), "utf8"),
  );
  if (!config || typeof config !== "object" || typeof config.budget_id !== "string") {
    throw new Error("YNAB budget is not configured");
  }
  return config.budget_id;
}

export async function runYnab(args) {
  const bunBin = join(homedir(), ".bun", "bin");
  const { stdout } = await execFileAsync(join(bunBin, "ynab"), args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: `${bunBin}:${process.env.PATH ?? ""}` },
  });
  return JSON.parse(stdout);
}

export async function listCategories() {
  return flattenActiveCategories(
    await runYnab(["categories", "list", "--budget", await budgetId(), "--compact"]),
  );
}

export async function transactionContext(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Transaction ID is invalid");
  const budget = await budgetId();
  const transaction = await runYnab(["transactions", "view", id, "--budget", budget]);
  if (!transaction || typeof transaction.payee_name !== "string") {
    return summarizeTransactionContext(transaction, []);
  }
  const history = await runYnab([
    "transactions",
    "search",
    "--budget",
    budget,
    "--payee-name",
    transaction.payee_name,
    "--fields",
    "id,date,amount,payee_name,category_name,deleted",
    "--compact",
  ]);
  return summarizeTransactionContext(transaction, history);
}
