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
| Catalogue, first page | 27 ms | 35 ms |
| Catalogue, last page (offset 101,100) | 296 ms | 332 ms |
| Catalogue, text search | 18 ms | 19 ms |
| Reconciliation, first page | 59 ms | 70 ms |
| Reconciliation, deep page | 53 ms | 60 ms |

Recorded in [`perf-baseline-admin.json`](perf-baseline-admin.json), which
`npm run measure:admin` compares against on every run — the table above and that file are
checked against each other by `app/lib/perf/readme-parity.test.ts`, so neither can go stale
while the other is right. Accept new numbers deliberately with `--record`.

Text search was 74 ms until #510 replaced two unusable `lower()` btrees with trigram GIN
indexes — **while the planner's statistics are current**. On stale statistics the same query
seq-scans at ~50 ms; `ANALYZE variant_index` restores it. See [`queries.md`](queries.md),
which records how that nearly got written up as the index not working.

The reconciliation rows read 7 ms and 5 ms until #513. They were taken against a store
with an empty ledger; at 125,070 verified rows both had become **~1,000 ms**, because the
drift query sorted the whole ledger and spilled to disk. An index in the `DISTINCT ON`
order removed the sort. See [`queries.md`](queries.md).

**These two are the reason to re-measure rather than trust the table.** They degraded with
*use*, not with catalogue size, so nothing about a bigger seed would have found it — and a
stale perf number is the one somebody quotes.

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

## Concurrency, and the pool size (#516)

```shell
npx tsx scripts/measure-concurrency.ts --shop anchor-perf
```

Every other number on this page is one statement at a time against an idle database. This
is the one that is not.

**Twenty merchants paging the catalogue at once**, no campaigns — the traffic that sizes
the web process's pool:

| `connection_limit` | Pages in 6s | p50 | p95 |
|---|---|---|---|
| 1 | 200 | 691 ms | 964 ms |
| 2 | 220 | 571 ms | 588 ms |
| **10** | **290** | **347 ms** | **775 ms** |
| 21 (the old default) | 316 | 301 ms | 683 ms |
| 40 | 318 | 290 ms | 709 ms |

**Four campaigns planning the whole catalogue, one merchant browsing:**

| `connection_limit` | admin p50 | admin p95 |
|---|---|---|
| 1 | 123 ms | 519 ms |
| 2 | 88 ms | 243 ms |
| 10 | 103 ms | 265 ms |
| 40 | 102 ms | 300 ms |

Idle floor: p50 25 ms, p95 44 ms. **A merchant paging the catalogue while campaigns plan
against the same tables waits about 5× longer than one on an idle store**, and no pool size
changes that much — past two connections the curve is flat. Zero pool timeouts at any size.

At sixteen concurrent whole-catalogue plans, admin p95 reaches 1–3 s and a *bigger* pool is
worse (pool 1: 1,048 ms; pool 10: 2,985 ms) — the pool acts as admission control, and
removing it just lets more heavy queries contend. Sixteen is well past anything the app
permits: the scheduler walks due campaigns in a `for` loop with an `await` in it, inside a
worker holding a cluster lock, so a worker plans one at a time.

**`connection_limit` is now 10, set explicitly** (`app/lib/db/pool.ts`, override with
`DATABASE_POOL_SIZE`). It was previously Prisma's `num_physical_cpus * 2 + 1`, read from
whatever container the process landed on — verified as 21 here against `pg_stat_activity`,
and it was 21 twice, once for web and once for the worker, with nothing accounting for
their sum against `max_connections`. Ten buys 91% of the throughput available at 40 for a
quarter of the connections.

Verified end to end rather than assumed — peak client backends observed while 40 concurrent
reads were in flight:

| `DATABASE_POOL_SIZE` | Backends |
|---|---|
| before this change | 21 |
| unset (default 10) | 10 |
| 3 | 3 |
| 25 | 25 |

## What these numbers do not cover

Webhook lag under load. Twenty sequential edits on an idle store is the best
case; the number that would matter during an incident is lag while a bulk import is
draining the same queue. `webhook.lag_ms` is emitted every tick now, so the panel will
answer that once there is traffic to look at.

## Query plans

The numbers above are wall clock. [`queries.md`](queries.md) is the layer under them —
what the filter engine and the planner ask Postgres, and which of those questions it can
answer from an index. Run with `npm run measure:queries`.
