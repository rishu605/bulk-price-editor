# Perf baselines

Measured on **anchor-perf.myshopify.com**, a Plus development store seeded to
102,132 variants across 2,001 products — including the 2,048-variant product E12 is about.

Regenerate with:

```shell
npx tsx scripts/measure-import.ts 2000 --variants 50 --shop anchor-perf --label 100k
npx tsx scripts/measure-import.ts --max-variant-product --shop anchor-perf --label e12
npx tsx scripts/measure-admin.ts --shop anchor-perf
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
| Catalogue, text search | 74 ms | 75 ms |
| Reconciliation, first page | 7 ms | 9 ms |
| Reconciliation, deep page | 5 ms | 6 ms |

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

## What these numbers do not cover

Concurrency. Every measurement here is one request at a time against an otherwise idle
store, so they are a floor rather than a forecast. A merchant paging the catalogue while a
100K campaign runs is a different question, and the honest answer is that it has not been
measured.
