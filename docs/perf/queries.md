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

### Finding 1 — five filter conditions cannot use an index, and two indexes cannot be used

**Fixed in #510.** The before/after is recorded under "After #510" below.


`vendor`, `productType`, `title`, `sku` and `barcode` all compile to `ILIKE`. `variant_index` carries
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

`barcode` had no index at all — not even an unusable one — and is the most selective
column of the five: 81,649 distinct values across 102,132 variants.

`vendor` and `productType` are deliberately left scanning. Low-cardinality equality over a
large fraction of the table is a heap read whatever index exists, and two more GIN indexes
maintained on every one of ~102K sync upserts is a poor trade for 9%.

### Finding 2 — `facets()` reads the whole catalogue to fill four dropdowns

**Fixed in #511.**

330 ms, one statement, every non-deleted row, four columns including two arrays — to
produce 10 vendors, 8 product types, 18 tags and 10 collections, each then
`.slice(0, 100)`. Three route loaders await it: the campaign editor, the costs page and
the segments page.

Only ~44 ms of that was Postgres. The rest was transferring and materialising 102,132 rows
to build four `Set`s.

Now four concurrent `GROUP BY` / `DISTINCT unnest` queries: **330 ms → 30 ms**, and 53 rows
crossing the wire instead of 102,132. Still four sequential scans — a distinct over the
whole catalogue has to read it — but that is the work, not overhead.

Two things fell out of it:

**The cap now admits to itself.** The list was always capped at 100 and never said so, and
a merchant with 412 tags could not tell "not in the first hundred alphabetically" from
"the app does not know this tag". Each picker's `details` now reads *"Showing 100 of 412
tags. Narrow the scope another way to reach the rest."*

**The sort stays in JavaScript, deliberately.** `ORDER BY` uses the database's collation,
and Homebrew's Postgres and Railway's do not agree — a Homebrew `ORDER BY` put
`accessories` between `Wax` and `Snowboard` where JS codepoint order puts every capital
first. That is the shape of #278, where `toLocaleString` rendered in the *server's* locale.
It is not cosmetic under a cap either: a different order is a different hundred values.
Verified byte-identical to the old output on all four shops in the local database.

### Finding 3 — planning issues one full scan of `baselines` per chunk, and that is currently correct

**Replaced in #524**, once measured past one store's size: see "After #524" below. Correct
as a choice between chunk sizes, which is all this section compared.

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

## After #510 — trigram indexes for the ILIKE conditions

`pg_trgm` enabled; `gin_trgm_ops` GIN indexes on `title`, `sku` and `barcode`; the two
`lower()` btrees dropped. Same store, same method.

| Path | Before | After |
|---|---|---|
| scope: title contains | 54 ms, 2 scans | **10 ms, 0 scans** |
| scope: sku contains | 29 ms, 2 scans | **2 ms, 0 scans** |
| scope: barcode contains | (unmeasured, 2 scans) | **2 ms, 0 scans** |
| scope: vendor | 31 ms, 2 scans | 34 ms, 2 scans — accepted |
| scope: product type | 35 ms, 2 scans | 35 ms, 2 scans — accepted |

The statement count fell from 63 of 70 reading a whole table to **59 of 72** — 72 because
`barcode` is now measured too. Nothing else in the report moved.

The merchant-visible one is the catalogue search box, which `measure:admin` times:

| | `lower()` btrees | Trigram GIN |
|---|---|---|
| Catalogue, text search (p50) | 49, 51, 52 ms | **18, 19, 18, 18 ms** |
| Catalogue, first page (p50) | 29 ms | 29 ms |

### The caveat that nearly became a wrong correction

Between those two measurements this query was observed at **48–70 ms with the trigram
indexes in place**, seq-scanning. It looked like the index did not help, and the obvious
reading — "the 19 ms was a warm cache right after `CREATE INDEX`" — was wrong.

`ANALYZE variant_index` restored it. The plan, on identical data:

```
stale statistics:  Parallel Seq Scan on variant_index    42 ms
after ANALYZE:     Bitmap Heap Scan → BitmapOr           35 ms
                     Bitmap Index Scan on variant_index_title_trgm
                     Bitmap Index Scan on variant_index_sku_trgm
```

`"jacket"` matches 14,624 of 105,869 rows — 14%, and a two-column `OR` at that selectivity
with `ORDER BY title LIMIT 50` sits close to the point where the planner's choice flips. The
chaos suite and the restore drills had churned the table enough to move the estimate onto
the wrong side of it.

**So the index's benefit is conditional on the statistics being current**, and that is an
operational fact rather than a footnote: after a large catalogue import, search can be ~3×
slower until autovacuum analyses the table. Worth knowing before somebody debugs it as a
regression.

**And the method matters more than the number.** Two wall-clock measurements taken in good
faith supported opposite conclusions. The plan did not: it says which index is used and why,
and it is the same answer whatever is in cache. Take the plan first.

Index bytes on `variant_index`: 21.3 MB removed (`title_lower` 14 MB, `sku_lower` 7.3 MB),
11.4 MB added (`title_trgm` 6.5 MB, `sku_trgm` 2.5 MB, `barcode_trgm` 2.4 MB). Net
−9.9 MB, and one fewer index maintained per row on the sync path despite covering one
more column.

`app/services/segments-index-coverage.test.ts` now fails the build if a condition is
matched with `mode: "insensitive"` on a column with no trigram index and no recorded
reason. It reads the index list out of `schema.prisma` rather than restating it, and its
field list is a `Record<ConditionField, …>` so a new condition fails typecheck until it is
classified.

## Reconciliation: a sort that spilled to disk (#513)

Found while measuring #510, and not caused by it — confirmed by restoring the old indexes
and re-measuring. `docs/perf/README.md` recorded 7 ms first page and 5 ms deep page; both
had become **~1,000 ms**.

`driftedCells` picks the newest verified write per cell with `DISTINCT ON (variantGid,
priceListGid) … ORDER BY …, verifiedAt DESC`. With no index in that order:

```
Sort (actual time=880.447..983.412 rows=125070)
  Sort Method: external merge  Disk: 9072kB
Execution Time: 1017.951 ms
```

983 ms of the 1,018 ms was one sort spilling out of the default 4 MB `work_mem` — for a
query returning **zero rows**. `variant_changes_drift_lookup`, partial on `VERIFIED` and
ordered to match, removes the sort entirely:

```
Index Scan using variant_changes_drift_lookup (actual time=0.017..30.704 rows=125070)
Execution Time: 71.776 ms
```

| | Before | After |
|---|---|---|
| Reconciliation, first page (p50) | 1,006 ms | **61 ms** |
| Reconciliation, deep page (p50) | 1,006 ms | **59 ms** |

**Replaced by `variant_changes_landed_lookup` (#792).** Clamped prices became their own
landed state, so the query reads `status IN ('VERIFIED', 'CLAMPED')` — and a partial index
on `VERIFIED` alone cannot serve that: on the same 125,070 rows the sort came straight back
(external merge, 9 MB on disk, **1,060 ms**). Partial on both states, it is an index scan
again at **93 ms**, and the previous release's `= 'VERIFIED'` query uses it too (56 ms), so
a rollback keeps its index. `reconciliation-counts.test.ts` holds the query's filter and the
index predicate together.

**This degraded with use, not with catalogue size.** One ledger row per variant × surface
× run, retained indefinitely because unlimited history is a deliberate free-tier feature;
#183 puts an active store at ~7.8M rows a year, and this was at 125K. No larger seed would
have found it — only a store that had *run campaigns*.

Two things worth carrying:

**`counts()` was silently capped.** It was `driftedCells(shopId).length`, and that helper
ends in `LIMIT 5000` — so a store with 8,000 drifted prices was told it had 5,000. The cap
is right for the cells list, which feeds a `WHERE … IN`; it was only ever wrong as an
answer to "how many". Both questions now compose the same predicate fragment, so they
cannot disagree about what "drifted" means.

**An intermittent 1 s outlier during this measurement was autovacuum**, not the query —
`pg_stat_user_tables` showed autovacuum and autoanalyze running on all three tables inside
the measurement window. Twelve consecutive calls afterwards ran 55–73 ms with no statement
over 200 ms. Worth checking before attributing a spike to the change under test.

`offBaselineCells` is left alone at 185 ms. It is already a merge join over two index
scans; comparing every surface entry to its baseline *is* the work.

## After #524 — a plan's baselines and live prices in one read each

`loadCandidates` now sends the scope's variant ids as one array, `"variantGid" = ANY($2)`, in
one read of `baselines` and one of `price_surface_entries`, inside a transaction that sets
`plan_cache_mode = force_custom_plan`. The conditions are the chunked reads' own, and the
scope is still the one Prisma query `astToWhere` compiles, so nothing about which variants
are in scope or what is read for them moved. `candidate-reads.chaos.ts` holds the new reads to
the old loader, kept there as the reference, over random catalogues and every condition field.

### Measured

Not on anchor-perf. The catalogue `app/lib/seed/catalogue.ts` builds was written straight
into a local database in the shape a sync and an install capture leave: 102,273 live
variants, 3,688 tombstoned, 110,758 baselines, 119,829 surface entries, which is
anchor-perf's shape. The old code's 1,384–1,411 ms is in line with anchor-perf's 1,288 ms.
`measure:queries`, old and new alternated three times:

| Path | Before | After |
|---|---|---|
| plan: candidates for the whole catalogue | 1,384–1,411 ms, 43 statements, 43 scans | **712–730 ms, 6 statements, 3 scans** |
| plan: candidates for a tag (19,292) | 288–297 ms, 9 statements, 8 scans | **163–164 ms, 6 statements, 2 scans** |
| statements reading a whole table, all paths | 69 of 97 | 23 of 51 |

Six statements, half of them the transaction's: `BEGIN`, the setting, `COMMIT`. The scans
left are one pass over each table, which is what a scope this wide costs.

What Postgres did for the whole-catalogue plan, every statement EXPLAINed and summed:

| | Before | After |
|---|---|---|
| rows read and discarded | 4,641,954 | **30,214** |
| buffer blocks | 103,761 | 9,456 |
| execution, summed | 491 ms | 83 ms |

Old and new alternating in one process, twelve runs each, so both saw the same load:

| Scope | Chunked (median) | One array (median) |
|---|---|---|
| whole catalogue, 101,788 candidates | 1,392 ms | **679 ms** |
| tag, 19,292 | 297 ms | **149 ms** |
| sku contains, 52 | 2 ms | 2 ms |

What is left of the 679 ms is mostly Prisma's, not Postgres's: about 216 ms to bring the
scope's rows back, 79 ms to sort them (#769), and about 100 ms of each read's 130 ms
sending 102,273 ids and receiving the rows. A narrow scope makes three more round trips for
the transaction than it did, about a millisecond.

### The exponent, measured

Finding 3 left open whether the chunks still won at ten times the size. There are two ways
to be ten times bigger, and they behave differently.

**Ten times the rows, from other shops**, as a production table is: 1,107,580 baselines and
1,198,290 surface entries, nine shops besides this one. The old reads did not get worse.
Postgres stopped scanning the table and read the shop's rows through its index instead, so
each chunk still read every row of *this shop*: 4,078,544 rows discarded, 1,355 ms. New:
13,346 discarded, 693 ms. The cost was the shop's size times the scope, never the table's.

**One shop three times the size**, which is the case that matters: 303,054 live variants and
301,617 candidates, seeded beside the first shop, so the tables held four times the rows.

| | Chunked | One array |
|---|---|---|
| statements | 123 | 6 |
| rows read and discarded | 55,327,251 | 427,431 |
| execution, summed | 4,730 ms | 231 ms |
| wall (median of six) | 6,711 ms | **2,150 ms** |

Three times the scope cost the chunks 9.6 times the Postgres time and 4.8 times the wall:
three times the chunks, each reading a table four times the size. The array cost 2.8 times
and 3.2 times, which is the rows themselves.

### The trap the first version fell into

`"variantGid" = ANY($2)` alone was faster in every one-off measurement, and would have shipped
a regression no measurement here could see:

| Both reads, 102,273 ids, one connection | Runs 1–5 | Runs 6–12 |
|---|---|---|
| `= ANY($2)` | 269–294 ms | **3,311–3,427 ms** |
| `= ANY($2)` with `force_custom_plan` | 251–260 ms | 245–263 ms |

Prisma keeps each statement prepared on its connection. From a prepared statement's sixth
execution, Postgres may plan it once without its values (`plan_cache_mode = auto`), and a
plan that cannot see the array's length guesses a dozen rows and probes the index once per
id: 270 ms where a scan took 9 ms, on 19,383 ids in `psql`. At 102,273 ids that is three and
a half times *slower* than the chunks. In production it would have been every plan after the
fifth on each pooled connection.

**Neither tool here saw it.** `EXPLAIN` plans with the values, so `measure:queries` reports
the first-five plan. A single wall-clock reading is a first-five reading too. Only twelve in
a row on one connection showed it. `SET LOCAL` keeps the setting to the transaction, so
nothing else on the connection is planned differently. Behind PgBouncer Prisma prepares
nothing and it changes nothing. `candidate-reads.chaos.ts` fails if a plan stops asking for
it.

### Not taken

- **A join to `variant_index` on the scope's filter**, the one-statement version #524
  measured at 62 ms for the baselines half. It needs the filter in SQL: a second translation of the AST beside
  `astToWhere`, and two translations of one scope are how a preview comes to disagree with
  its run (rule 4).
- **A relation Prisma could filter through.** It needs a foreign key from `baselines` to
  `variant_index`, which a baseline for a variant the mirror does not have fails (#252).
- **One statement joining both tables.** About 45 ms faster at 102K. Two reads keep each
  table's conditions exactly as they were, and that was worth more than 45 ms here.

Imported prices (`price_import_rows`) are still read 5,000 ids at a time, and only for a
campaign with a `from-import` rule. Not measured: the seeded catalogue has no imports.

## What this does not cover

Concurrency, same as `measure-admin`. Every number here is one statement at a time against
an otherwise idle database, so they are a floor. A merchant paging the catalogue while a
100K campaign plans is a different question.

Nor a prepared statement past its fifth execution. `EXPLAIN` plans with the values bound, and
each path here runs once, so a statement Postgres would later plan without them reads as
fast as its first plan. See "The trap the first version fell into" above.

Nor is any of it from a real beta merchant. `anchor-perf` is synthetic — uniform variant
counts, 16 vendors, tags applied evenly. Real catalogues are lumpy, and lumpy is what
breaks a plan that depends on a selectivity estimate. #160's "worst-performing real beta
store" clause stays open until there is one.
