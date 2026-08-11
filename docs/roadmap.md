# Roadmap

Phase-by-phase execution plan. Tasks are sized to ≤3 days; anything larger gets split.
**Req** traces to [`prd.md`](prd.md) requirement IDs or [`rfc-001-architecture.md`](rfc-001-architecture.md) sections.

Calendar estimates are honest guesses for 1–2 engineers full-time, not commitments.
Phases 0–2 are the irreducible core; everything after re-sequences on beta feedback.

| Phase | Weeks | Theme |
|---|---|---|
| P0 | 1 | Foundations |
| P1 | 2–3 | Catalog index & baseline ledger |
| P2 | 3–5 | Resolver & job engine |
| P3 | 5–9 | Core product |
| P4 | 9–12 | Private beta & hardening |
| P5 | 12–18 | Markets surface, billing, launch |
| P6 | rolling | Expansion |

---

## Phase 0 · Foundations

**Exit:** app installs on dev stores, CI green, webhook ingress verified, scopes empirically
confirmed, seeded 100K-variant test store exists.

| ID | Task | Req | Done when |
|---|---|---|---|
| P0.1 | Partner org, app creation via CLI, TOML config, two dev stores (small + perf) | — | App opens embedded in both stores |
| P0.2 | **Empirical scope verification:** exercise every mutation in RFC §6 on a dev store; record the minimal scope set | B10 | Documented scope list; TOML updated |
| P0.3 | Postgres + Redis provisioning (staging + prod); Prisma schema bootstrap (shops, webhook_events); migration pipeline in CI | B3 | Migration deploys via CI to staging |
| P0.4 | Webhook ingress: raw-body HMAC, dedup insert, enqueue, fast 200; register app-lifecycle + compliance topics | B2, B10 | Replayed duplicate processed once; compliance topics respond correctly |
| P0.5 | Worker process skeleton, BullMQ wiring, graceful shutdown, leader-elected tick stub | B5 | Tick logs every 30s across restarts, single leader |
| P0.6 | Observability skeleton: Sentry, OTel metrics, structured logs, staging dashboard | B11 | A thrown test error and a test metric appear in dashboards |
| P0.7 | Perf-store seeder: 2K products × 50 variants (100K) incl. a 2,048-variant product, multi-currency markets enabled | NFR | Seeded store matches spec; re-run documented |
| P0.8 | GraphQL codegen, version-pinned typed client, budget-manager stub reading `throttleStatus` | B8 | Typed query runs; observed budget logged per call |
| P0.9 | Dev-dependency upgrade: `@typescript-eslint` 6→8 (with eslint 8→9 flat config) and `@shopify/api-codegen-preset`, clearing 15 high-severity advisories inherited from the template. All build-time only — no runtime dependency is affected | — | `npm audit` clean; lint/typecheck/build still green |

## Phase 1 · Catalog index & baseline ledger

**Exit:** 100K-variant store mirrored <30 min; webhook lag p95 <30s; every variant has a
current baseline; CSV baseline import works.

| ID | Task | Req | Done when |
|---|---|---|---|
| P1.1 | Bulk query composer + streamed JSONL parser → `variant_index` upserts (memory-bounded) | A-1.1, B7 | Perf store imports <30 min, RSS <512MB |
| P1.2 | Market/B2B price-list snapshot → `price_surface_entries`; serialize with the bulk-query slot | A-1.1, B6 | All seeded market prices mirrored |
| P1.3 | Webhook consumers: products create/update/delete → mirror upsert/tombstone; lag metric | B7 | Admin edit reflected ≤30s p95 under load |
| P1.4 | Baseline capture job (all surfaces) + onboarding progress screen; scoped recapture + audit entries | A-1.2 | 100% coverage post-install; recapture audit-logged |
| P1.5 | Baseline CSV import: streamed parse, SKU/handle/gid matching, row-level error file, dry-run mode | A-1.2, A-5.3 | 500K-row file processes with correct error file |
| P1.6 | Nightly sampled mirror audit + divergence alert + targeted re-sync | B7, B11 | Injected divergence detected and healed on staging |
| P1.7 | Baseline browser UI (filters, per-variant history) — debug-grade polish | A-1.2 | Support can answer "what is this variant's baseline and why" |

## Phase 2 · Resolver & job engine

**Exit:** chaos suite green; 50K-variant apply + revert verified-clean on the perf store;
invariants I1–I6 property-tested in CI.

| ID | Task | Req | Done when |
|---|---|---|---|
| P2.1 | Money lib (integer minor units, currency precision) + rounding lib (charm/step/direction, zero-decimal) | A-3.1, A-3.2 | Property tests across 20 currencies pass (E9, E10) |
| P2.2 | Resolver + rule engine (all A-3.1 rule kinds) + guardrail clamp | B4 | I1, I2, I6 property tests green |
| P2.3 | Run planner: enrollment snapshot, resolve-diff, streamed ledger materialization, path choice, no-op skip | B5 | 50K-row plan builds <60s with correct skip counts |
| P2.4 | Sync executor: per-product grouping, budget-managed `productVariantsBulkUpdate`, verifier read-back | B5, B6 | 800-row run verified-clean incl. injected 429s (E17) |
| P2.5 | Bulk executor: JSONL build, staged upload, submit, finish-webhook + poll fallback, result parse, row marking | B5, B6, E13 | 50K-row run verified-clean; dropped webhook recovered by poll |
| P2.6 | Retry/poison policy + resume (re-plan non-verified only) | A-4.2, E2 | Run killed at 40% resumes to an identical final state (checksum) |
| P2.7 | Self-echo registry + `products/update` diff consumer → `drift_events` | B5, A-4.5 | Our writes produce zero drift events; a manual edit produces one ≤60s |
| P2.8 | Chaos harness in CI (worker kill, webhook drop, 429 storm, mid-run product delete) | B11, E4 | Suite green three consecutive runs |
| P2.9 | Revert as resolver-recompute + drift-aware rollback report | A-4.4, I3 | E1's six orderings pass as integration tests |

## Phase 3 · Core product

**Exit:** a merchant can do everything in Epics 2–4 on the base surface through the UI;
onboarding tested with outsiders; parity checklist vs NA / RUBIX / Springify / GJ green.

| ID | Task | Req | Done when |
|---|---|---|---|
| P3.1 | Filter AST engine over the mirror + debounced count/sample endpoint | A-2.1 | Every condition returns correct sets on fixtures; count p95 <1.5s |
| P3.2 | Segments CRUD (dynamic/frozen) + reference guard + CSV-as-filter → frozen segment | A-2.2, A-2.4 | Unmatched-row report; deletion blocked while referenced |
| P3.3 | Campaign wizard steps 1–2 (scope, rule) with live sample math | UX | Draft saves at every step; sample updates as you type |
| P3.4 | Wizard steps 4–5 (schedule, review): conflict panel, preview table, guardrail report, blast-radius confirm | A-3.5, A-3.6, A-3.11 | Overlap shows resolved winner pre-save; 10K preview <5s |
| P3.5 | Campaign lifecycle wiring incl. partial and held states in UI | A-4.1, A-4.3 | State machine renders truthfully incl. resume button |
| P3.6 | Campaign detail: run history, per-row ledger with filters, per-variant rollback | A-4.1, A-4.4 | Support can trace any variant's price story end-to-end |
| P3.7 | Drift queue UI + three-way resolution + policy setting | A-4.5 | E3 flow passes usability test |
| P3.8 | Guardrails settings + campaign overrides + typed override confirm | A-3.7 | I6 holds; overrides audit-logged |
| P3.9 | Scheduling UI incl. recurrence subset + occurrence preview/skip; DST rules | A-3.5, B9, E14 | Three consecutive weekly occurrences run correctly on staging clock tests |
| P3.10 | Auto-enroll consumer (create/update → segment match → baseline → price) + opt-out | A-3.9, E6 | New product priced ≤5 min; both events ledgered |
| P3.11 | Tags kit (add/remove, ledgered) | A-3.10 | Revert provably removes tags incl. auto-enrolled |
| P3.12 | Notifications: completion/failure/drift/revert emails + preferences | A-4.7 | Close-the-tab flow works end to end |
| P3.13 | Dashboard v1 + activity log + audit export | A-5.1, A-4.8 | All dashboard cards live with real data |
| P3.14 | Onboarding: capture progress, guided ≤5-product first campaign, practice mode, checklist | A-5.4, G4 | 3 of 4 outside testers finish a first campaign <10 min unassisted |

## Phase 4 · Private beta & hardening

**Exit:** 10–20 real stores through ≥2 full promo cycles; zero stuck jobs; support docs
exist; Built-for-Shopify pre-audit clean.

| ID | Task | Req | Done when |
|---|---|---|---|
| P4.1 | Beta recruitment (competitor 1–3★ reviewers, community threads on Markets/compounding) + interview script | GTM | ≥10 active stores, ≥3 multi-market |
| P4.2 | In-app feedback widget + weekly beta digest review ritual | — | Feedback triaged into the P5/P6 backlog weekly |
| P4.3 | Perf tuning from real catalogs (index sizes, query plans, chunk sizing) | NFR | Targets met on the worst real beta store |
| P4.4 | Failure-drill week: chaos scenarios on staging while beta shadows prod paths | B11 | All alerts fire correctly; runbooks written |
| P4.5 | Help center: concepts (baseline, resolver), how-tos, failure FAQs; in-app contextual links | GTM | Every UI error links to a doc |
| P4.6 | Built-for-Shopify pre-audit: performance, design, integration sweep | B10 | No known criterion failures |

## Phase 5 · Markets surface, billing, launch

**Exit:** public listing live with Markets campaigns, recurrence, calendar, CSV,
reconciliation; billing enforced; first paying customers.

| ID | Task | Req | Done when |
|---|---|---|---|
| P5.1 | Markets write path: `priceListFixedPricesAdd` executor (250/req chunking) + per-market compare-at + delete-on-revert | A-3.4, B6 | USD/EUR/JPY strike-through campaign applies and reverts, verified on all three |
| P5.2 | Uniform-% optimization via `PriceListParent` when applicable, explained in the review step | B6 | Uniform campaign uses 1 mutation/market; mixed falls back to fixed |
| P5.3 | Per-currency rounding profiles + market surface in wizard step 3 + per-surface preview matrix | A-3.2, A-3.4 | E9 passes; preview shows per-market columns |
| P5.4 | Market topology sync (markets/price-list CRUD detection) | E15 | Deleting a targeted price list mid-campaign prompts correctly |
| P5.5 | Campaign calendar (month/week, overlap badges, create-from-slot) | A-5.2 | Beta merchants schedule from the calendar unprompted |
| P5.6 | Reconciliation view (store-wide, filters, spot-check action) | A-4.6 | 1,000-variant spot check matches fresh reads |
| P5.7 | Remaining CSV I/O: price/cost imports, all exports, Matrixify headers | A-5.3 | Round-trip on 50K rows with an error file |
| P5.8 | Managed pricing: 4 tiers, gates (variant caps, surfaces), trial, downgrade read-only behavior | A-5.6, E8 | Upgrade/downgrade tested in billing test mode |
| P5.9 | Listing: copy, screenshots (reconciliation + per-market compare-at lead), screencast, demo store | GTM | Listing submitted |
| P5.10 | App review submission + fix loop; launch comms to beta (review ask post verified-clean campaign) | GTM | App public; first 10 reviews in motion |

## Phase 6 · Expansion

Demand-sequenced. Each track gets its own mini-RFC before build.

| ID | Track | Contents | Gate |
|---|---|---|---|
| P6.1 | B2B surface | Catalog targeting, `quantityPricingByVariantUpdate` chunk-transactions, wholesale guardrails, `read_companies` scope | ≥3 paying stores with B2B catalogs |
| P6.2 | Margin & P&L | Preview margin deltas; post-campaign window vs trailing window; `read_orders` + protected-data approval | Approval granted (paperwork starts at P5) |
| P6.3 | Cost editing | Rule/CSV cost updates, floor recalc, violation flags on active campaigns | — |
| P6.4 | Flow connectors | Triggers started/ended/held; actions start/end/capture | — |
| P6.5 | Approvals & audit+ | Two-person rule, approver in audit, SSO-friendly export | Plus-merchant demand signal |
| P6.6 | Discount-mode | Function-executed campaigns + sale-item code blocker; one multiplexing function (5-discount cap) | ≥30% of paying merchants request it |
