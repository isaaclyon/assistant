---
name: watch-prices
description: "Creates, reviews, and retires temporary product price watches. Use when asked to watch a price, monitor discounts, or stop a product alert."
---

# Watch prices

Individual watches are temporary private task data, never source-code constants
or skill examples based on the user's shopping list. Store them under the jobs
coordinator's `temporary/price-watches/<id>/watch.json`. The generic helper below
publishes their scheduler projection into `jobs.json`; do not edit that projection
separately. Read the scheduling skill for scheduler status and acknowledgement.

## Set up a watch

1. Identify the exact product, variant, source, and currency. Search personal
   memory if the request refers to a saved gift or purchase idea.
2. Verify the source live. Use a supported reusable adapter: `shopify` product
   JSON plus page currency, `schema` Product JSON-LD with exact SKU and URL,
   or `steam` package API with exact package ID, name, country, and currency.
   Pin variantId for a multi-variant Shopify product. Otherwise exactly one
   variant must exist. Unsupported sites need a temporary research job or a
   genuinely reusable adapter; never add a product-specific checker.
   When the user explicitly wants any available variant of the same product,
   `variantPolicy: "lowest-available"` selects that minimum. Never combine it
   with variantId or use it to compare different editions against one baseline.
3. Record baseline evidence and its verification date. Keep the baseline fixed;
   never reset it to a sale price. Supported currencies use two decimal minor
   units: USD, EUR, GBP, CAD, AUD, HKD, NZD, CHF. Do not assume native prices are USD.
4. State when the task ends: purchase, removal from the relevant list, user
   cancellation, or an agreed deadline. Do not invent a deadline. These end
   conditions require agent evaluation; there is no automatic purchase detector
   or date expiry. For a deadline, schedule an explicit retirement reminder.
5. Create the watch with the helper. Require publication.status `accepted`
   before saying it is scheduled; pending/rejected saves need investigation.

Run from the release root, sending one JSON request on stdin:

```sh
node dist/src/price-watches.js <<'EOF'
{"operation":"upsert","id":"sample-price-watch","watch":{"source":{"kind":"shopify","url":"https://shop.example.com/products/sample","id":"123","variantId":"456","currency":"USD"},"baselineCents":"5000","mode":"ratio","createdAt":"2026-01-01T12:00:00Z","baselineEvidence":"Verified regular price USD 50 on the source page, 2026-01-01 (synthetic example).","endCondition":"Retire after purchase or user cancellation.","job":{"target":"isaac","schedule":"0,5 9 * * *","tz":"America/Denver","rule":{"type":"condition","operator":"less-than","target":8001,"for":"1s","notify":"once-per-episode"},"onTrigger":{"type":"prompt","prompt":"Check whether this temporary watch is still wanted; retire it if its end condition is met. Otherwise verify the exact product, price and stock before reporting the qualifying discount. Report shipping and tax separately; do not purchase."}}}}
EOF
```

`mode: ratio` emits current price / fixed baseline in basis points, rounded up.
At least 20% off uses `less-than: 8001`. `mode: price` emits major currency units
for an absolute threshold. Unavailable items emit a nonmatching high value.
Two successful matching observations are required even for `for: "1s"`;
schedule a confirmation observation close to the first, rather than a day later.
Notifications are once per sale episode. Operational failures preserve the last
successful observation and must not be reported as “no discount.”

The `source` also accepts `name` and two-letter lowercase `country` for Steam.
Steam package prices do not prove hardware stock; verify stock before alerting.
All adapters exclude shipping and tax. They fetch public HTTPS only, reject
redirects/private addresses, and do not log in or run page JavaScript.

## Inspect and retire

Use `{"operation":"read","id":"sample-price-watch"}` with the same helper.
List current scheduler jobs using the scheduling skill and compare publication
acknowledgements; a manifest alone is not proof of an active watch.

When the user buys/removes an item, cancels, or an agreed deadline arrives, call
`{"operation":"retire","id":"sample-price-watch"}`. The helper removes the
job, verifies host acceptance, and moves its manifest under
`temporary/price-watches/retired/`. It preserves audit context; deleting these
private records is a separate requested cleanup. Do not retain dormant watches
as permanent capabilities. A notification is not automatically the end of a watch.
