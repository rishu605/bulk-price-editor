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
| D11 | **Shopify's cost wins where Shopify has one** (#737) | The guardrails read the current baseline's cost before the mirror's, and only the mirror followed Shopify, so a cost raised in Shopify left "never below cost" on the old one. Each catalogue sync now copies a non-null Shopify cost onto the current base baseline. A spreadsheet cost import fills the costs Shopify does not hold, and survives a sync because an empty Shopify cost is never copied. A cost is not a price: campaign maths still reads the baseline's price (rule 1). |
| D12 | **Campaigns cover active products unless the merchant ticks draft or archived** (#751) | A scope used to cover every status because nothing said otherwise, so a sale repriced and tagged drafts a merchant was still preparing (and held itself when they priced one in Shopify) and archived products that came back discounted. The default lives in the reader (`productStatusesOf`): a campaign with nothing recorded, which is every campaign made before #751, covers active products from its next run. That moves running campaigns' scopes, deliberately — nobody chose draft or archived for them — and strands nothing: a whole-campaign revert takes back every price the campaign wrote, in scope or not (#828). Price imports cover every status, because a file names each variant it prices. Segments keep meaning every status; the campaign narrows them. |
| D13 | **No store-wide drift policy setting yet: drift always holds for review** (#818, deferred) | PRD A-4.5 and A-5.5 describe a default drift policy (hold, adopt as baseline, reassert) chosen in Settings. Only *hold* ships, with *adopt* and *reassert* as per-event choices in the drift queue. Each of the other two defaults would act on a merchant's edit with nobody looking. Defaulting to *adopt* would quietly move baselines, so every later campaign and every revert would compute from a price nobody approved (rule 1). Defaulting to *reassert* would overwrite a deliberate edit, and it would fight any other app or person who keeps writing that price. Hold is the only one that never writes a price nobody saw, and the drift email plus the queue make it cheap to answer. Revisit when beta merchants ask for it: either a shop whose edits come from a known system (an ERP or a repricer) wants *adopt* by default, or one whose staff edit by mistake wants *reassert*. If it ships, it should be scoped to an edit source rather than store-wide, and be audit-logged like the confirmation thresholds. |
| D14 | **Variant writes ask Shopify for partial updates** (#1020) | Without `allowPartialUpdates`, `productVariantsBulkUpdate` writes none of a call's variants if any one is refused, so one variant deleted mid-run (E4) or one refused price failed up to 250 of its product's. The ledger, the read-back and every report treat each row as standing or falling on its own, and the chaos fake had always written the valid ones, so the suite could not see the difference. Both write paths now send `allowPartialUpdates: true`, and the fake writes nothing for a call that omits it, so dropping the flag fails the scenarios. A deleted variant is skipped (E4) on the bulk path as on the sync path. Still to confirm on `anchor-perf`: Shopify's behaviour for a deleted variant inside a 250-variant call with the flag set. |
| D15 | **A start nobody watches needs a stored confirmation, and it covers a tenth more prices and one point more depth** (#1009) | The scheduler and Flow cannot ask anyone to type *apply*, so the word is asked when their start is decided: saving dates in the editor or on the campaign page, or confirming the campaign for Flow on its Overview tab. Who confirmed, when, and what the campaign reached then (prices written, how many past the change threshold, the largest move, how many at the smallest price) are kept in the campaign's `schedule` JSON. A start is checked on the run's own plan and refused when it needs the word and reaches further than that. Refused for good through #975's path for a scheduled start, a 4xx for Flow. It stays when the dates move, since moving them changes nothing the campaign writes, and the check runs again anyway. A copy leaves it behind, since nobody confirmed the copy. **The allowance is a judgement call.** Counts may grow by a tenth (none under ten) and the largest change by one percentage point. Exact equality would leave a confirmed Black Friday sale unstarted because three products joined its collection overnight, or because rounding put a new product at 60.4% off under a 60% sale. A tenth is far short of the mistakes the word is for: a scope widened to the catalogue, or a rule with an extra digit. Small deep campaigns get no count slack at all. Tighten to exact if a merchant is surprised by a start that grew; loosen if confirmed sales are refused for ordinary catalogue growth. |
| D16 | **A price one campaign's revert hands to another is the planner's answer, not a ledger record** (#998) | When B ends over A, B's revert writes A's price (rule 6), and the row sits under B's revert: that run held the claim (rule 2) and committed the row before writing (I4), and its read-back is what verified it (I5). Moving the row under one of A's runs would break all three, and a new "priced for" column would be a second record of something the resolver already decides. So the readers that need to know ask the planner instead (`lib/planning/handover.ts`): plan the variant as if live were what the revert wrote, and the campaign the plan leaves it with took it over. Drift detection uses that when a variant's newest write is a revert's, and a whole revert takes back what the campaign was handed as well as what it wrote, even after the product has left its scope. |
| D17 | **A variant named on several rows of an import file gets its first row, and every later row is refused** (#989) | The price and baseline imports used the first row and refused the rest. The cost import (#767) refused every row of the variant, so one spreadsheet meant two things depending on the page it went to. The price and baseline imports stream: a file is staged or written 500 to 1,000 rows at a time, and a repeat can turn up after its first row is in a committed batch. "Refuse every row" would then mean undoing staged prices or superseding baselines already written, which is the half-applied import #736 removed. The cost import reads the whole file before writing, so it could refuse all, but a rule only one importer can keep isn't one rule. All three now share `firstRows` and `duplicateRefusal` (`lib/baselines/csv-rows.ts`). A repeat is a problem of kind *duplicate*: it is counted in *Need attention* and in the problem download, and it names the row it repeats and the row that is used ("Line 14 repeats this variant's line 3; only line 3 is used"). The first row is used even when it changes nothing. Using the first row is safe because the check lists every repeat before the form offers a commit (#766). The price import's commit is also refused server-side unless it is the checked rows (#989); the cost and baseline imports' commits are not checked server-side yet (#1059). Revisit if merchants want the last row to win, for example an export they append corrections to by hand. That would be a one-line change in `firstRows`. |
| D18 | **Archiving a live or scheduled campaign stays allowed, and says what it leaves running** (#748) | Archiving files a campaign away and changes nothing it does: `archivedAt` is read by the index and nothing else, so an archived Active campaign's prices stay live and an archived scheduled one still starts on its date. That was deliberate and said nowhere, and the list's default view, which leaves archived campaigns out, read it as ended. The other option was to refuse Archive while prices may be live or a start is coming, and say "revert or cancel it first". It was not taken: it is the larger change to a control merchants already use, a refused filing decision teaches them archive is unreliable, and Revert and Cancel or unschedule are already one press away for a merchant who means to stop it. Instead, in those states (`RUNS_WHEN_ARCHIVED`: `PRICES_MAY_BE_LIVE` plus SCHEDULED, in `lib/campaigns/archive-warning.ts`), Archive asks first and names what keeps happening, dated in the store's zone ("Its prices stay live on your storefront", "It will still start 27 Nov 2026, 09:00 (America/New_York)"). The campaigns list counts archived campaigns still running across the shop and links to exactly those (`status=live`), and their Archived badge is a warning. Draft, completed and cancelled campaigns still archive in one click, and Restore never asks. Revisit if merchants still archive live campaigns by mistake past the dialog: refusing is then the fix. |

## Open

| # | Decision | Resolves at | Notes |
|---|---|---|---|
| D4 | Exact minimal scope set | **Resolved P0.2, one narrowing open** | `write_products` does cover products, variants, price lists *and* catalogs — all thirteen mutations in RFC §6 pass under it. Markets needs its own scope; `read_orders` and `read_companies` are genuinely not needed until P6.2/P6.1. Detail below. |
| D6 | App name + App Store listing name | **Proposed, pending availability** | App name "Anchor"; listing name "Anchor: Bulk Price Editor & Market Pricing". The listing name carries the terms merchants type, because search rank in this category depends on it; the app name stays short because that is what sits in the admin sidebar daily. Cannot be *closed* until the Partner dashboard confirms availability — a taken name makes every other choice here moot. Copy drafted in `docs/app-store-listing.md`. |
| D7 | Free-tier cap (500 vs 250 variants) | post-launch data | Start at 500 — deliberately aggressive against NA's 100 changes/month. Tighten if conversion suffers; never tighten the safety features. |
| D8 | Pull B2B surface forward into P5 | beta signal | Swap with the calendar if the beta cohort skews B2B-heavy. |
| D9 | Managed pricing vs the newer usage-billing App Events path | **Resolved P5.8, revised 13 Oct 2026 (#860)** | Flat recurring plans, never usage billing. Variant caps are enforced in-app against the campaign's own scope, which needs no usage reporting at all — and usage billing would have meant emitting an App Event per priced variant, which is both a per-change meter by another name (contradicting D3) and a second source of truth about what we did. **Charged through the Billing API, with the listing on manual pricing** — not Shopify App Pricing; see below. |

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

### D9, revisited: the Billing API, not Shopify App Pricing (13 Oct 2026, #860)

App Review paused the submission under requirement 1.2.1. The plan page sent merchants to
Shopify App Pricing's hosted picker, but the Partner Dashboard listing is on **manual
pricing** and no App Pricing plans were ever created, so the picker was Shopify's 404. The
reviewer could not find a working charge.

Two ways out, and the Billing API is the one taken:

- **It is what the listing already says.** Manual pricing means the app creates its own
  charges. App Pricing would have meant switching the listing, building the four plans in
  the Partner Dashboard, and — because App Pricing stopped sending subscription webhooks
  after 28 Apr 2026 — a Partner API client to read plan state from. That adds a credential
  and a second API to the billing path.
- **Everything runs on the Admin token the app already holds.** `appSubscriptionCreate`
  makes the charge; `currentAppInstallation.activeSubscriptions` is the truth;
  `app_subscriptions/update` still arrives for Billing API subscriptions, and #709's
  ordering guard applies to it unchanged.
- **The plans live in `plans.ts`.** `billing-api.ts` builds the library's `billing` config
  from it, so what Shopify charges, what the app gates and what the listing promises
  (`listing-parity.test.ts`) come from one table.

What it commits us to:

- Prices and trials are changed in code, and the Partner Dashboard's manual-pricing
  details must be edited to match on the same release.
- A trial is given once per shop. Changing plan carries over what is left, and cancelling or
  reinstalling does not start another, because `trialEndsAt` is kept through both.
- Switching to Free cancels the subscription with proration, so the unused part of the
  month comes back to the merchant as a credit.
- Development stores keep every feature free, but can still change plan with **test
  charges**. That is how App Review tries the flow.
- Uninstalling resets the plan to Free, so a reinstall asks for approval again (1.2.2).

## Reversed during planning

| Decision | Why it was reversed |
|---|---|
| Change-count metering (100 free / 1,000 / 10,000 ladder, the category norm) | Copied from incumbents in a first draft, then rejected: it charges merchants for using the product's core loop and penalises exactly the recurring-campaign behavior we want to encourage. Replaced by D3. |
| A 40,000-points-per-minute rate-limit model | Came from a secondary source. Real limits are a 1,000-point bucket restoring at 50 pts/s on standard plans. This makes the bulk-operation path the default rather than an optimization, and the budget manager mandatory. See RFC §8. |
| Spreadsheet-grid editing UI at launch | BulkPriceBoard's 2.1★ collapse shows a grid without an industrial job engine behind it is a trap; Matrixify and Mixtable already serve spreadsheet-first users. CSV round-trip covers the need. Reconsider as a v2 view over the same campaign model. |
| Shipping-profile changes inside campaigns | Real merchant pain, but the `deliveryProfile` write APIs are mid-migration (tiered rates replacing legacy fields) and writing merchant-managed profiles is high blast-radius. Deferred until the API settles. |
