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
| D4 | Exact minimal scope set | **Resolved P0.2, one narrowing open** | `write_products` does cover products, variants, price lists *and* catalogs — all thirteen mutations in RFC §6 pass under it. Markets needs its own scope; `read_orders` and `read_companies` are genuinely not needed until P6.2/P6.1. Detail below. |
| D6 | App name + App Store listing name | **Proposed, pending availability** | App name "Anchor"; listing name "Anchor: Bulk Price Editor & Market Pricing". The listing name carries the terms merchants type, because search rank in this category depends on it; the app name stays short because that is what sits in the admin sidebar daily. Cannot be *closed* until the Partner dashboard confirms availability — a taken name makes every other choice here moot. Copy drafted in `docs/app-store-listing.md`. |
| D7 | Free-tier cap (500 vs 250 variants) | post-launch data | Start at 500 — deliberately aggressive against NA's 100 changes/month. Tighten if conversion suffers; never tighten the safety features. |
| D8 | Pull B2B surface forward into P5 | beta signal | Swap with the calendar if the beta cohort skews B2B-heavy. |
| D9 | Managed pricing vs the newer usage-billing App Events path | **Resolved P5.8** | Managed pricing. Variant caps are enforced in-app against the campaign's own scope, which needs no usage reporting at all — and usage billing would have meant emitting an App Event per priced variant, which is both a per-change meter by another name (contradicting D3) and a second source of truth about what we did. |

### D4, in more detail

Resolved by `npm run scope:probe`, which asks Shopify rather than reading the docs. The
probe sends each mutation an input engineered to fail validation — an id no store can
hold, or an empty list — because authorization is checked when the field resolves, *before*
the input is validated. A `userErrors` response therefore means the mutation ran,
considered our nonsense and declined it, which is a pass that changes nothing.

Run against `boltify-apps.myshopify.com` on 26 Aug 2026, granted `write_markets,
write_products`:

| Mutation | Verdict | What Shopify said |
|---|---|---|
| `productVariantsBulkUpdate` | pass | Product does not exist |
| `bulkOperationRunQuery` | pass | Invalid bulk query: syntax error |
| `bulkOperationRunMutation` | pass | Failed to parse the mutation |
| `stagedUploadsCreate` | pass | (accepted an empty list) |
| `priceListCreate` | pass | Catalog does not exist. |
| `priceListUpdate` | pass | Price list does not exist. |
| `priceListFixedPricesAdd` | pass | Price list does not exist. |
| `priceListFixedPricesDelete` | pass | Price list does not exist. |
| `quantityPricingByVariantUpdate` | pass | Price list not found. |
| `catalogCreate` | pass | Market not found. |
| `catalogUpdate` | pass | Catalog does not exist |
| `tagsAdd` / `tagsRemove` | pass | Product does not exist |
| `markets` (query) | pass | — |
| `companies` (query) | **denied** | Access denied for companies field. |

**The docs' generous claim holds.** One scope covers products, variants, price lists and
catalogs, including the B2B mutations P6.1 will need. That is the good outcome and it was
worth proving rather than assuming, because the listing is built on it.

**`read_companies` is a scheduled cost, not a gap.** Nothing that ships now touches it —
the B2B *pricing* mutations pass under `write_products`; only displaying which companies a
catalog is assigned to needs it. Adding a scope after launch re-prompts every existing
install, so it is recorded here as a known price of P6.1 rather than discovered during it.

**`read_orders` stays out.** It triggers Protected Customer Data review and is only needed
for the revenue half of P6.2. Same reasoning: a known future cost, deliberately not paid
early.

**Two scopes the seeding script wants and will not get.** Setting stock on a seeded
catalogue needs a location id, and both routes to one are closed: `locations` answers
"Access denied", and a variant's `inventoryLevels` answers "Required access:
`read_inventory`". Neither goes in the manifest — no *feature* reads a location or an
inventory level, and the mirror gets `inventoryQuantity` from the product graph, which
`read_products` already covers. `scripts/seed-store.ts` takes `--location` instead, pasted
from admin by whoever runs it. A permission checkbox in front of every merchant is not a
reasonable price for a developer tool being easier to run.

**Resolved: `write_markets` narrowed to `read_markets`.** Nothing in the app writes a
market. Every mutation it sends is a price list, catalog, product, tag, staged upload or
bulk operation — all covered by `write_products` — and the only markets access ever
exercised is reading which markets exist.

That could not be settled by probing, and the attempt showed why twice over. A scope that
is present is never exercised as absent, so with `write_markets` granted every probe
passes whether or not it needs the scope. And **narrowing the manifest does not narrow an
existing install**: after the change the CLI reported `Access scopes auto-granted:
read_markets, write_products`, while the stored grant still read `write_markets,
write_products`. A smaller ask needs no new consent, so the old grant simply persists.
Only a reinstall would settle it, and uninstalling a store to prove a scope is not a
reasonable trade.

So the argument is static, and enforced rather than asserted: a test in
`app/lib/compliance/built-for-shopify.test.ts` fails if any market mutation is ever added.
Adding one is a legitimate thing to want — doing it without widening the manifest is a run
that fails on every merchant store, and doing it with one is a re-authorisation prompt for
every existing install. Either way it should be a decision rather than a surprise.

The install screen now asks to *view* the merchant's markets rather than to *manage* them.

**Previously open, for the record: `write_markets` was over-broad.** Nothing in the app writes a market. The
market surface works by creating and updating *price lists*, which `write_products`
covers; the only markets access ever exercised is reading which markets exist. The install
screen currently asks to *manage* the merchant's markets when it only needs to *view*
them, which is not a small difference in a sentence somebody reads before handing a
pricing app access to their store.

This cannot be confirmed by probing, and the report says so. A probe reports what fails
under the grant in force, and a scope that is present is never exercised as absent —
confirming the narrowing means editing the manifest, reinstalling, and asking again. Filed
rather than done, because guessing wrong here breaks the market surface, which is the
product.

The manifest's `read_markets` has been dropped in the meantime: Shopify implies it from
`write_markets` and had already collapsed the pair in its own record of what was granted,
so declaring it was a checkbox that bought nothing either way.

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
