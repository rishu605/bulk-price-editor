# Perf baselines

Measured on **anchor-perf.myshopify.com**, a Plus development store seeded to
102,132 variants across 2,001 products — including the 2,048-variant product E12 is about.

Regenerate with:

```shell
npx tsx scripts/measure-import.ts 2000 --variants 50 --shop anchor-perf --label 100k
npx tsx scripts/measure-import.ts --max-variant-product --shop anchor-perf --label e12
npx tsx scripts/measure-admin.ts --shop anchor-perf
npx tsx scripts/measure-webhook-lag.ts --shop anchor-perf --edits 20
npx tsx scripts/drill-mirror.ts --shop anchor-perf
```

## Import (#66)

| | Measured | Budget |
|---|---|---|
| Wall clock, 100,078 variants | **2.8 min** | 30 min |
| Peak RSS, sampled every 2s | **94 MB** (84 samples) | 512 MB |
| The 2,048-variant product | **2,048 mirrored** | complete (E12) |

The third row was a failure until #291. `variants(first: 100)` on the catalogue page query
dropped 1,948 of that product's variants with no error — a campaign covering it would have
priced 100, missed the rest, and reported the run clean. Nothing caught it because no store
had a product bigger than one page until this one existed.

## Admin queries, against 102,132 variants

| Query | p50 | max |
|---|---|---|
| Catalogue, first page | 26 ms | 26 ms |
| Catalogue, last page (offset 101,100) | 292 ms | 360 ms |
| Catalogue, text search | 19 ms | 21 ms |
| Reconciliation, first page | 7 ms | 9 ms |
| Reconciliation, deep page | 5 ms | 6 ms |

Text search was 74 ms until #510 replaced two unusable `lower()` btrees with trigram GIN
indexes. The two reconciliation rows are **stale**: both now measure ~1,000 ms against the
same store, which grew 21 campaign runs and 125,579 ledger rows after these were taken.
Tracked separately — see [`queries.md`](queries.md).

### Offset scaling

| Page | Offset | p50 |
|---|---|---|
| 1 | 0 | 25 ms |
| 306 | 15,250 | 195 ms |
| 817 | 40,800 | 217 ms |
| 1,430 | 71,450 | 256 ms |
| 2,023 | 101,100 | 285 ms |

Deep paging costs about 11× the first page and flattens out rather than degrading — the
curve between offset 15,250 and 101,100 is 195 ms to 285 ms, which is a long way from the
quadratic behaviour a naive `OFFSET` on an unindexed sort would give.

## Webhook lag: a price edit reaching the mirror (#4)

| | Measured | Budget |
|---|---|---|
| p50 | **1,518 ms** | — |
| p95 | **1,772 ms** | 30,000 ms |
| max | 1,772 ms | — |
| Delivered | **20 of 20** | all |

Measured the way a merchant produces it: the price is edited through the Admin API
*without* recording a write intent, so the resulting webhook is indistinguishable from
somebody typing in the Shopify admin, and the mirror is then polled until it agrees. Every
price is put back afterwards, and the restoring webhook is waited for too, so a slow one
cannot be charged to the next measurement.

This is the number that decides whether planning against the mirror is safe. A campaign
scoped a minute after somebody edits a price is planning against whatever the mirror knew
then — so it is the width of the window in which the app can be wrong about a store, not a
vanity metric. At under two seconds the window is narrow enough that the drift path, not
this, is what catches a real conflict.

## Mirror-corruption drill (#4)

| | |
|---|---|
| Clean audit first | 60 checked, 0 diverged |
| Corrupted | **3,064 of 102,132** rows (3%) |
| Dirty audit | 400 sampled, **18 diverged, 18 healed** |
| Alerted at | **4.50%**, against a 0.5% threshold |
| Restored afterwards | 3,046 rows the sample never reached |

`mirror-audit.chaos.ts` proves the same behaviour against the fake. This proves it against
a real store and a real Shopify, which is a different claim: the harness cannot tell you
that the live read path, the session, the rate limiter and the healing write all work
together on a catalogue of a hundred thousand variants.

**The shape of the drill is the lesson.** The audit samples randomly, so an early version
that corrupted twenty rows out of 102,132 and sampled twenty found nothing — which looked
like a broken audit and was a broken drill. It corrupts a *fraction* instead, chosen well
over the alert threshold so the alert must fire rather than might.

## What these numbers do not cover

Concurrency. Every measurement here is one request at a time against an otherwise idle
store, so they are a floor rather than a forecast. A merchant paging the catalogue while a
100K campaign runs is a different question, and the honest answer is that it has not been
measured.

Webhook lag under load, likewise. Twenty sequential edits on an idle store is the best
case; the number that would matter during an incident is lag while a bulk import is
draining the same queue. `webhook.lag_ms` is emitted every tick now, so the panel will
answer that once there is traffic to look at.

## Query plans

The numbers above are wall clock. [`queries.md`](queries.md) is the layer under them —
what the filter engine and the planner ask Postgres, and which of those questions it can
answer from an index. Run with `npm run measure:queries`.
