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
| D5 | **Railway**, web and worker as two services from one repo | Resolved from [`reference-patterns.md`](reference-patterns.md): the author already runs this exact stack (React Router + Postgres/Prisma + BullMQ worker) in production on Railway, so the deployment shape is proven rather than assumed. Worker gets its own service — it is the only price writer and must restart and scale independently of web traffic. Region/data-residency still to confirm at provisioning. |

## Open

| # | Decision | Resolves at | Notes |
|---|---|---|---|
| D4 | Exact minimal scope set | **P0.2** | Docs indicate `write_products` covers products, variants, price lists and catalogs. Verify empirically against every mutation in RFC §6 before the listing is built. Over-asking hurts install conversion. |
| D6 | App name + App Store listing name | P4–P5 | "Anchor" is a working title chosen for the baseline concept; needs an availability check and a keyword-bearing listing name, as the category does. |
| D7 | Free-tier cap (500 vs 250 variants) | post-launch data | Start at 500 — deliberately aggressive against NA's 100 changes/month. Tighten if conversion suffers; never tighten the safety features. |
| D8 | Pull B2B surface forward into P5 | beta signal | Swap with the calendar if the beta cohort skews B2B-heavy. |
| D9 | Managed pricing vs the newer usage-billing App Events path | **Resolved P5.8** | Managed pricing. Variant caps are enforced in-app against the campaign's own scope, which needs no usage reporting at all — and usage billing would have meant emitting an App Event per priced variant, which is both a per-change meter by another name (contradicting D3) and a second source of truth about what we did. |

### D9, in more detail

Usage billing looked attractive for the variant cap because it bills what is actually
used. It was rejected for three reasons:

- **It is change metering wearing a different hat.** D3 rejected charging per change
  because it taxes the core loop and penalises recurring campaigns. Emitting a billable
  event per priced variant reintroduces exactly that, with the added downside that a
  merchant cannot predict their bill before running a campaign.
- **It would create a second record of what we wrote.** The ledger is the record. A
  billing event stream that could disagree with it is a support burden and, worse, a
  thing somebody might reconcile *against* the ledger.
- **The cap does not need it.** A campaign's scope is known before it runs, so the gate
  is a count against a number, checked in the run path. That also lets the app refuse in
  advance with a sentence, rather than billing for something and explaining later.

The decision to revisit if: a merchant asks to be charged for a one-off large campaign
rather than upgrading a tier for a month. That is a real shape and managed pricing serves
it badly.

## Reversed during planning

| Decision | Why it was reversed |
|---|---|
| Change-count metering (100 free / 1,000 / 10,000 ladder, the category norm) | Copied from incumbents in a first draft, then rejected: it charges merchants for using the product's core loop and penalises exactly the recurring-campaign behavior we want to encourage. Replaced by D3. |
| A 40,000-points-per-minute rate-limit model | Came from a secondary source. Real limits are a 1,000-point bucket restoring at 50 pts/s on standard plans. This makes the bulk-operation path the default rather than an optimization, and the budget manager mandatory. See RFC §8. |
| Spreadsheet-grid editing UI at launch | BulkPriceBoard's 2.1★ collapse shows a grid without an industrial job engine behind it is a trap; Matrixify and Mixtable already serve spreadsheet-first users. CSV round-trip covers the need. Reconsider as a v2 view over the same campaign model. |
| Shipping-profile changes inside campaigns | Real merchant pain, but the `deliveryProfile` write APIs are mid-migration (tiered rates replacing legacy fields) and writing merchant-managed profiles is high blast-radius. Deferred until the API settles. |
