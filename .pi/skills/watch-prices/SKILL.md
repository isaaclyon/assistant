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

## Choose a working tracking method

A request to track a price authorizes setting up a temporary watch with existing
capabilities. Personal bots can configure watches and scheduled research checks;
they do not need the builder for each new retailer or product. A new reusable
adapter requires a repository change and deployment through the builder.

Do not treat the adapter list as a retailer allowlist. Before saying a product
cannot be tracked:

1. Inspect the exact regional product page live. Establish product identity,
   requested size/color or other variant, currency, current price, and stock.
   A missing dedicated retailer adapter does not establish incompatibility.
2. Check whether its public data fits an existing adapter. Product JSON-LD must
   fit the deployed `schema` adapter's exact SKU, URL, offer, currency, and
   availability requirements; merely finding JSON-LD is insufficient. Test the
   candidate with `dist/src/checkers/retail-product-price.js`, passing the same
   JSON arguments that the watch will use, before publishing it. A browser-visible
   price alone does not prove that this non-browser checker can read it.
3. If the adapter fails but an available browser or research tool can reliably
   verify the requested product and price, use the scheduled research fallback
   below. Test that method now before promising future checks.
4. If neither method works, report the observed blocker (for example, access
   denied, ambiguous variant, or price unavailable). Distinguish a failed check
   from an untested method. Explain whether a reusable adapter could help and
   offer builder work when appropriate; do not promise it will overcome an
   access restriction.

Describe the selected method in plain language: an automated price check or a
scheduled browser/research check. Give its cadence and any material limitation.
Proceed with the requested watch when the product, threshold, and cadence are
clear. Ask only for missing choices that materially affect the result, including
an acceptable frequency if none is established; do not ask the user to choose
an internal adapter.

## Set up a watch

1. Identify the exact product, variant, source, and currency. Search personal
   memory if the request refers to a saved gift or purchase idea.
2. Verify the source live. Use a supported reusable adapter: `shopify` product
   JSON plus page currency, `schema` Product JSON-LD with exact SKU and URL,
   or `steam` package API with exact package ID, name, country, and currency.
   Pin variantId for a multi-variant Shopify product. Otherwise exactly one
   variant must exist. If these adapters cannot read the source, follow the
   scheduled research fallback; never add a product-specific checker.
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

## Scheduled research fallback

Use an ordinary `cron` prompt job through the scheduling skill, targeted to the
requesting personal bot. This wakes the agent to inspect the page at each check,
so it uses more agent time and depends on continued page/tool access. It does
not require a new executable checker or deployment. Keep any browser sign-in or
human verification requirements within the browser skill's existing workflow.

Store its private task data under the coordinator's
`temporary/price-research/<id>/task.json`. Use this separate task kind because
the price-watch helper owns adapter-backed heartbeat manifests and cannot
publish or retire research cron jobs. Record the product URL and identity,
variant, region/currency, fixed baseline and dated evidence (for a discount
threshold), alert condition, verified research method, schedule/timezone,
recipient, job ID, creation time, and end condition. Keep mutable observations
and notification history there too. Use private directory/file permissions.

Create a self-contained cron prompt that points to that task file and instructs
the future agent to:

- Read the task, evaluate its end condition, and retire it if appropriate.
- Use the verified method to check the exact product, variant, currency, current
  price, and availability. Recheck a qualifying price before alerting; include
  the source link and separate shipping/tax from the item price.
- Compare against the recorded threshold and fixed baseline. Record successful
  observations and notify once per qualifying sale episode. A successful
  nonmatch re-arms alerts; failures preserve the last successful observation and
  notification history. Return exactly `NO_REPLY` when no new alert is due.
- Record access/extraction failures as failures, never as full price or no sale.
  Report the first loss of access and material changes to that blocker; suppress
  repeated identical failure notices until recovery. Record recovery so another
  loss of access can be reported.

Verify scheduler publication is `accepted` before saying the research check is
scheduled. Retire it by removing its cron job with the jobs helper, verifying
accepted removal, and moving its task directory into
`temporary/price-research/retired/` with a retirement timestamp. For a deadline,
also schedule explicit retirement as with adapter-backed watches. Do not leave
a dormant recurring job after its end condition is met.

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
