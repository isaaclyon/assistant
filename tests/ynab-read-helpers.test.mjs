import { describe, expect, it } from "vitest";

import {
  flattenActiveCategories,
  summarizeTransactionContext,
} from "../.pi/skills/manage-ynab/scripts/ynab-read.mjs";

describe("YNAB read helpers", () => {
  it.each([
    { amount: { unexpected: "payload" } }, { approved: ["not", "boolean"] },
    { date: { nested: true } }, { memo: "x".repeat(4001) }, { amount: Infinity },
    { category_name: ["Dining"] }, { account_name: {} },
  ])("rejects malformed transaction scalar fields: %j", (fields) => {
    expect(() => summarizeTransactionContext({ id: "current", payee_name: "Merchant", ...fields }, []))
      .toThrow(/invalid transaction context/i);
  });

  it("rejects malformed matching history and oversized active category names", () => {
    expect(() => summarizeTransactionContext({ id: "current", payee_name: "Merchant" }, [
      { id: "old", payee_name: "Merchant", date: { nested: true }, amount: [1], category_name: "Dining" },
    ])).toThrow(/invalid transaction context/i);
    expect(() => flattenActiveCategories([{ name: "x".repeat(501), categories: [{ id: "id", name: "Dining" }] }]))
      .toThrow(/invalid categories/i);
  });

  it("flattens active categories with their group names", () => {
    expect(
      flattenActiveCategories([
        {
          name: "Everyday",
          hidden: false,
          deleted: false,
          categories: [
            { id: "dining", name: "Dining", hidden: false, deleted: false },
            { id: "old", name: "Old", hidden: true, deleted: false },
          ],
        },
        { name: "Deleted", deleted: true, categories: [{ id: "x", name: "X" }] },
      ]),
    ).toEqual([{ id: "dining", name: "Dining", group: "Everyday" }]);
  });

  it("summarizes exact-payee category history without repeating the current transaction", () => {
    expect(
      summarizeTransactionContext(
        {
          id: "current",
          date: "2026-07-15",
          amount: -52.6,
          payee_name: "DoorDash",
          category_name: "Uncategorized",
          account_name: "Card",
          memo: null,
          approved: false,
        },
        [
          { id: "current", payee_name: "DoorDash", category_name: "Uncategorized" },
          { id: "one", date: "2026-06-01", amount: -40, payee_name: "DoorDash", category_name: "Dining", deleted: false },
          { id: "two", date: "2026-05-01", amount: -30, payee_name: "DoorDash", category_name: "Dining", deleted: false },
          { id: "three", date: "2026-04-01", amount: -20, payee_name: "DoorDash", category_name: "Dates", deleted: false },
          { id: "other", payee_name: "Door Dash", category_name: "Dining", deleted: false },
        ],
      ),
    ).toEqual({
      transaction: {
        id: "current",
        date: "2026-07-15",
        amount: -52.6,
        payee: "DoorDash",
        category: "Uncategorized",
        account: "Card",
        memo: null,
        approved: false,
      },
      exactPayeeHistory: {
        transactionCount: 3,
        categoryCounts: [
          { category: "Dining", count: 2 },
          { category: "Dates", count: 1 },
        ],
        recent: [
          { date: "2026-06-01", amount: -40, category: "Dining" },
          { date: "2026-05-01", amount: -30, category: "Dining" },
          { date: "2026-04-01", amount: -20, category: "Dates" },
        ],
      },
    });
  });
});
