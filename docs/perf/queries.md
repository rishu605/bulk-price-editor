# Query plans for targeting and planning

What the filter engine and the planner actually ask Postgres, and how Postgres answers it
against a real 102,132-variant catalogue.

```shell
npm run measure:queries -- --shop anchor-perf
```

The script runs the real service functions — `previewMatches`, `facets`,
`resolveVariantGids`, `loadCandidates` — captures every statement Prisma emits, and runs
`EXPLAIN (ANALYZE, BUFFERS)` on each one. It writes nothing.

**Why it captures rather than quotes.** An EXPLAIN of a hand-copied query measures the
query you believe the ORM builds. The first finding below exists precisely because those
two things had diverged: the filter engine asks for `equals` with `mode: "insensitive"`,
Prisma emits `ILIKE`, and the `lower(vendor)`-shaped indexes built to serve it cannot be
used by `ILIKE` at all. Nothing on the Prisma side says so, and the index had recorded
zero scans since it was created.

## Baseline, 30 August 2026 — before any change

`anchor-perf.myshopify.com`, 102,132 variants, 106,889 baselines, 116,000 surface entries.
Warm cache, one request at a time.

| Path | Wall | Statements | Reading a whole table |
|---|---|---|---|
| scope: whole catalogue | 44 ms | 2 | 1 |
| scope: tag | 13 ms | 2 | 0 |
| scope: collection | 1 ms | 2 | 0 |
| scope: vendor | 31 ms | 2 | **2** |
| scope: product type | 35 ms | 2 | **2** |
| scope: title contains | 54 ms | 2 | **2** |
| scope: sku contains | 29 ms | 2 | **2** |
| scope: price floor | 19 ms | 2 | 2 |
| facets: the scope picker's options | **330 ms** | 1 | 1 |
| enrol: every gid in scope | 24 ms | 1 | 0 |
| plan: candidates for a tag | 274 ms | 9 | 8 |
| plan: candidates for the whole catalogue | 1,288 ms | 43 | **43** |

**63 of 70 statements read a whole table.** That headline is worth less than it looks,
because three different things are hiding behind it and only two are defects.

### A full scan is not automatically a bug

`scope: price floor` matches 90,589 of 105,869 rows and `scope: whole catalogue` matches
all of them. Reading the table is the correct plan for both — an index that returns 86% of
a table costs more than the scan it replaces. Those rows stay in the table above as
context, not as work.

The distinction matters because the obvious response to a scan count is to add indexes
until it reaches zero, which buys write amplification on the sync path in exchange for
plans Postgres will decline to use.

### Finding 1 — four filter conditions cannot use an index, and two indexes cannot be used

`vendor`, `productType`, `title` and `sku` all compile to `ILIKE`. `variant_index` carries
`variant_index_title_lower` (14 MB) and `variant_index_sku_lower` (7.3 MB), both btrees on
`lower(col)`, and Postgres cannot serve `ILIKE` from either. Both report **zero scans**
since creation, and no raw SQL in `app/` uses `lower(` — so this is structural, not a
sampling artefact.

Measured against a trigram index instead:

| Condition | Matches | Seq scan | `gin_trgm_ops` |
|---|---|---|---|
| `sku contains "APF-927"` | 52 | 24.7 ms | **0.6 ms** |
| `title contains "Alpine"` | 8,354 | 38.9 ms | **4.0 ms** |
| `productType = "Boots"` | 12,680 | 27.5 ms | **5.6 ms** |
| `vendor = "Northwind"` | 11,973 | 28.5 ms | 25.9 ms |

The win tracks selectivity, which is the honest way to read it: a search that finds 52
rows gets 42× and a filter that matches 11% of the catalogue gets nothing worth having.
The trigram indexes are also *smaller* than the dead ones they replace — 6.5 MB for
`title` against 14 MB, 2.5 MB for `sku` against 7.3 MB.

Tracked as its own ticket. `vendor` and `productType` are deliberately left scanning:
low-cardinality equality over a large fraction of the table is a scan whatever index
exists, and two more GIN indexes maintained on every one of 102K sync upserts is a poor
trade for 9%.

### Finding 2 — `facets()` reads the whole catalogue to fill four dropdowns

330 ms, one statement, every non-deleted row, four columns including two arrays — to
produce 16 vendors, 15 product types, 18 tags and 10 collections, each then
`.slice(0, 100)`. Three route loaders await it: the campaign editor, the costs page and
the segments page.

Only ~44 ms of that is Postgres. The rest is transferring and materialising 102,132 rows
to build four `Set`s. `SELECT DISTINCT` does the same work in the database in 37 ms and
returns 53 rows.

Tracked as its own ticket.

### Finding 3 — planning issues one full scan of `baselines` per chunk, and that is currently correct

`loadCandidates` over the whole catalogue emits 43 statements: 21 chunks × `baselines`,
21 × `price_surface_entries`, plus the scope query. Every one is a sequential scan, each
discarding ~100,869 rows.

This looks worse than it is. With 5,000 values in the `IN` list, Postgres correctly
judges one pass over a 106,889-row table cheaper than 5,000 index probes. Measured across
chunk sizes, planning the full catalogue:

| `IN_CHUNK` | Batches | baselines | surfaces | Total |
|---|---|---|---|---|
| 250 | 409 | 3,272 ms | 3,082 ms | 6,354 ms |
| 500 | 205 | 2,224 ms | 2,185 ms | 4,409 ms |
| 1,000 | 103 | 2,194 ms | 2,299 ms | 4,493 ms |
| 2,000 | 52 | 1,122 ms | 964 ms | 2,087 ms |
| **5,000 (current)** | 21 | 983 ms | 758 ms | **1,740 ms** |
| 10,000 | 11 | 908 ms | 740 ms | 1,648 ms |
| 20,000 | 6 | 865 ms | 712 ms | 1,577 ms |

**5,000 is the right value and stays.** Dropping to 250 is 3.7× slower; the 9% available
above it is not worth spending the headroom that `IN_CHUNK` exists to preserve — that gap
is deliberate room under Postgres's 32,767 bind-variable ceiling for a caller to add
another filter years from now, not tuning slack. See `app/lib/db/chunk.ts`.

**The part that is a real risk, and is not visible here.** Chunks scale with the size of
the *scope* and each scan costs the size of the *table*, so total work is O(scope × table).
At 102K variants that product is small enough that the scan wins. It is not obvious that
it still wins at ten times the ledger, and this catalogue cannot answer that. Recorded
rather than guessed at.

## What this does not cover

Concurrency, same as `measure-admin`. Every number here is one statement at a time against
an otherwise idle database, so they are a floor. A merchant paging the catalogue while a
100K campaign plans is a different question.

Nor is any of it from a real beta merchant. `anchor-perf` is synthetic — uniform variant
counts, 16 vendors, tags applied evenly. Real catalogues are lumpy, and lumpy is what
breaks a plan that depends on a selectivity estimate. #160's "worst-performing real beta
store" clause stays open until there is one.
