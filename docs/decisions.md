# Decision log

Open decisions are reviewed at each phase exit. When one closes, edit its row rather than
appending a new one, and note the reasoning.

## Committed

| # | Decision | Reasoning |
|---|---|---|
| D1 | React Router 7 template, Polaris web components, Postgres + Prisma, Redis + BullMQ | Shopify's current recommended path; relational fits the ledger; BullMQ gives delayed/repeatable jobs out of the box. Rails alternative closed. |
| D2 | Resolver + baseline architecture; write-ahead ledger; verified-clean semantics | This is the product's identity — it is what competitors structurally cannot retrofit. |
| D3 | Pricing meters variants-under-management + surface gating, **not** change counts | Change metering taxes the core loop and makes recurring campaigns (a differentiator) expensive to run. Safety features are never paywalled. |
| D10 | No storefront theme code, ever | Theme-facing code risks the Built-for-Shopify performance budget and drags us into theme-support burden. Campaign-scoped tags give themes the hook instead. |

## Open

| # | Decision | Resolves at | Notes |
|---|---|---|---|
| D4 | Exact minimal scope set | **P0.2** | Docs indicate `write_products` covers products, variants, price lists and catalogs. Verify empirically against every mutation in RFC §6 before the listing is built. Over-asking hurts install conversion. |
| D5 | Hosting vendor (Fly vs Railway) + region / data residency | P0.3 | Cost plus an EU-residency question. Either works technically. |
| D6 | App name + App Store listing name | P4–P5 | "Anchor" is a working title chosen for the baseline concept; needs an availability check and a keyword-bearing listing name, as the category does. |
| D7 | Free-tier cap (500 vs 250 variants) | post-launch data | Start at 500 — deliberately aggressive against NA's 100 changes/month. Tighten if conversion suffers; never tighten the safety features. |
| D8 | Pull B2B surface forward into P5 | beta signal | Swap with the calendar if the beta cohort skews B2B-heavy. |
| D9 | Managed pricing vs the newer usage-billing App Events path | P5.8 spike | Managed pricing is the default; the usage path only if variant-cap enforcement demands it. |

## Reversed during planning

| Decision | Why it was reversed |
|---|---|
| Change-count metering (100 free / 1,000 / 10,000 ladder, the category norm) | Copied from incumbents in a first draft, then rejected: it charges merchants for using the product's core loop and penalises exactly the recurring-campaign behavior we want to encourage. Replaced by D3. |
| A 40,000-points-per-minute rate-limit model | Came from a secondary source. Real limits are a 1,000-point bucket restoring at 50 pts/s on standard plans. This makes the bulk-operation path the default rather than an optimization, and the budget manager mandatory. See RFC §8. |
| Spreadsheet-grid editing UI at launch | BulkPriceBoard's 2.1★ collapse shows a grid without an industrial job engine behind it is a trap; Matrixify and Mixtable already serve spreadsheet-first users. CSV round-trip covers the need. Reconsider as a v2 view over the same campaign model. |
| Shipping-profile changes inside campaigns | Real merchant pain, but the `deliveryProfile` write APIs are mid-migration (tiered rates replacing legacy fields) and writing merchant-managed profiles is high blast-radius. Deferred until the API settles. |
