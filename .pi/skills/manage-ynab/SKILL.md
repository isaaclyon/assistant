---
name: manage-ynab
description: "Reads and manages YNAB budgets with ynab-cli, including budget summaries, account/category lookups, transaction search and creation, and extracting simple or split transactions from uploaded receipts. Use for questions or actions involving YNAB, budgets, spending, accounts, categories, transactions, or receipts."
compatibility: "Requires an authenticated `ynab` CLI available on PATH. Receipt extraction requires the uploaded image or PDF to be available to the agent."
---

# Manage YNAB

Use the authenticated [`ynab`](https://github.com/stephendolan/ynab-cli) CLI. It returns JSON and accepts dollar amounts rather than YNAB milliunits.

## Private defaults

Store non-secret defaults in `~/.config/pi-telegram-bridge/ynab.json`:

```json
{
  "budget_id": "budget UUID",
  "account_id": "account UUID",
  "category_id": "optional fallback category UUID"
}
```

This file is private runtime configuration: never add it to the repository. The API token remains owned by `ynab auth`; never read, print, copy, or store it in this file.

Before the first operation, verify `command -v ynab` and `ynab auth status`. If defaults are absent, use `ynab budgets list`, `ynab accounts list --budget <budget-id>`, and `ynab categories list --budget <budget-id>` to present choices, then ask the user before writing the selected IDs to the private config. Do not guess defaults. If a configured ID no longer exists, ask the user to replace it.

Read the config with a short Node command or the available file tool. Do not echo unrelated home-directory files.

## General rules

- Use `--budget <budget-id>` explicitly on every budget-scoped command.
- Treat outflows as negative amounts and inflows as positive amounts.
- Use exact IDs in writes. Resolve friendly account and category names by listing them first.
- When the user omits an account while logging a transaction, search recent transactions for the payee (and date/amount when available) before using the configured account fallback. If the payee has a clear historical account pattern, use the most frequently used matching account; if the history is split or inconclusive, use the configured fallback and say so. Do not infer an account from a card hint without checking for conflicts.
- Prefer concise summaries over dumping raw JSON. Include the month/date and currency units.
- Never use `ynab api` when a first-class command supports the operation, except to create a split receipt atomically as described below.
- Do not create categories or payees; the YNAB API cannot create them. `--payee-name` may associate or create the transaction's payee behavior server-side.
- Respect the API limit of 200 requests per hour. Avoid repeated full-list calls in one turn.
- If authentication or keychain access fails in the service environment, report the error without exposing credentials.

## Reading budgets

Choose the narrowest command for the question:

```bash
ynab budgets view <budget-id>
ynab months view <YYYY-MM-01> --budget <budget-id>
ynab accounts list --budget <budget-id>
ynab categories list --budget <budget-id>
ynab transactions summary --budget <budget-id> --since <YYYY-MM-DD> --until <YYYY-MM-DD> --top 10
ynab transactions list --budget <budget-id> --since <YYYY-MM-DD> --limit 100
ynab transactions search --budget <budget-id> --payee-name <name> --since <YYYY-MM-DD>
```

For “how is my budget?” default to the current month and summarize: income/activity if available, total budgeted, total spent/activity, remaining/available, overspent categories, and notable low balances. Do not imply that available money is cash on hand; distinguish category availability from account balances.

## Explicit transaction requests

When the user explicitly types complete transaction details, create it directly without an extra confirmation. Ask only for missing or materially ambiguous details. When the user omits the account, resolve it from payee history as described above, using the configured account fallback if needed. Resolve the category from the transaction context before using the configured category fallback. State which fallback defaults were used in the result.

```bash
ynab transactions create \
  --budget <budget-id> \
  --account <account-id> \
  --date <YYYY-MM-DD> \
  --amount <-12.34> \
  --payee-name <merchant> \
  --category-id <category-id> \
  --memo <memo> \
  --approved
```

Shell-quote every user-derived value. Never build commands by interpolating unquoted receipt or message text. After a write, inspect the JSON response and report the transaction ID and final fields. Updates require a clear user instruction. Deletions and force-splitting an existing transaction always require confirmation because they are destructive.

## Receipt workflow

### 1. Inspect and extract

Open the uploaded image or PDF with the available image/document tool. Extract:

- merchant
- transaction date
- final charged total (not subtotal)
- tax and tip when visible
- card/account hint such as last four digits
- line items, discounts, and their amounts
- currency

Do not invent obscured values. Mark uncertain fields and ask about anything that changes the transaction. Ignore card numbers beyond the last four digits and do not repeat sensitive payment details.

### 2. Resolve YNAB fields

- Start with the configured budget and account.
- If the receipt's payment hint conflicts with the configured account, ask which account to use.
- Search recent matching transactions by merchant, date, and amount to detect likely duplicates before proposing a write.
- Resolve categories using existing YNAB category names. Consider the payee, transaction description, receipt contents, and existing category names first; use the configured category only when there is no more specific or well-supported choice, and state when the fallback was used.
- For an itemized receipt, propose splits only when line items map reasonably to distinct existing categories. Combine same-category items. Apply tax, tip, and discounts explicitly or proportionally, and ensure split amounts sum exactly to the negative receipt total to the cent.

### 3. Always confirm receipt-derived writes

Show a compact preview containing budget, account, date, payee, total, category or splits, memo, and any uncertainty. Ask for explicit confirmation before calling any write command. A caption such as “add this receipt” authorizes preparation, not the final write. If the user changes a field, show the revised preview and confirm again.

The confirmation covers one transaction attempt only. If the command fails or the proposed fields change, do not retry a write without explaining the failure and obtaining confirmation again.

### 4. Create a simple receipt

After confirmation, use `ynab transactions create` as shown above. Default receipt transactions to `--approved` and `--cleared uncleared` unless the user says otherwise.

### 5. Create an itemized split atomically

The CLI's `transactions create` command cannot create subtransactions. After confirmation, use one raw API request rather than creating and then mutating a transaction:

```bash
ynab api POST '/budgets/<budget-id>/transactions' --data '<json>'
```

The JSON body must have this shape, with amounts converted from dollars to integer milliunits (negative for receipt outflows):

```json
{
  "transaction": {
    "account_id": "account UUID",
    "date": "YYYY-MM-DD",
    "amount": -12340,
    "payee_name": "Merchant",
    "category_id": null,
    "memo": "Receipt",
    "cleared": "uncleared",
    "approved": true,
    "subtransactions": [
      { "amount": -10000, "category_id": "category UUID", "memo": "Items" },
      { "amount": -2340, "category_id": "category UUID", "memo": "Other items" }
    ]
  }
}
```

Build JSON with a JSON serializer, not manual string concatenation. Verify both parent and split milliunits sum exactly before the request. Never use the two-step `create` then `split` flow for a new receipt because a failed second call would leave a partial transaction.

## Errors and output

On CLI failure, summarize the actionable error and do not claim the budget changed. Never expose environment variables, keychain contents, tokens, or full raw error objects that may contain request headers. On success, provide a short human-readable result rather than the entire API payload.
