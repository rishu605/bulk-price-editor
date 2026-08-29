-- Search indexes that the search queries can actually use.
--
-- `astToWhere` matches `title` and `sku` with `contains` + `mode: "insensitive"`, and
-- Prisma compiles that to `ILIKE '%text%'`. The catalogue and reconciliation search
-- boxes do the same. No btree serves ILIKE -- including a btree on `lower(title)`,
-- which is exactly what the original data model created for this purpose:
--
--   -- Case-insensitive prefix search on SKU and title for the picker and filter builder.
--   CREATE INDEX "variant_index_sku_lower" ON "variant_index" (LOWER("sku"));
--   CREATE INDEX "variant_index_title_lower" ON "variant_index" (LOWER("title"));
--
-- A btree on `lower(sku)` does serve `lower(sku) LIKE 'abc%'`, so the comment describes
-- a query that would have worked. The code never issued it. Both indexes reported zero
-- scans since creation on a store with 102,132 variants, and no raw SQL in app/ uses
-- `lower(` -- so this is structural, not a sampling artefact.
--
-- Measured on anchor-perf (#160, docs/perf/queries.md):
--
--   sku contains "APF-927"    52 matches   24.7ms -> 0.6ms
--   title contains "Alpine" 8,354 matches  38.9ms -> 4.0ms
--
-- The replacements are smaller than what they replace: 6.5MB against 14MB for title,
-- 2.5MB against 7.3MB for sku. Net -12MB, and 21MB less index maintenance on every one
-- of the ~102K upserts a catalogue sync performs.
--
-- Deliberately NOT indexed: `vendor` and `productType`. They compile to ILIKE too, but
-- they are low-cardinality equality -- "Northwind" matches 11% of the catalogue, and
-- reading 11% of a heap costs the same however it is reached. Measured at 28.5ms
-- scanning against 25.9ms with a trigram index, which does not pay for a GIN index
-- maintained on every sync write.
--
-- pg_trgm is a trusted extension from PG13, so this needs no superuser on Railway.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "variant_index_title_trgm" ON "variant_index" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "variant_index_sku_trgm" ON "variant_index" USING GIN ("sku" gin_trgm_ops);
CREATE INDEX "variant_index_barcode_trgm" ON "variant_index" USING GIN ("barcode" gin_trgm_ops);

-- Contract in the same migration as the expand, which the expand/contract rule normally
-- forbids. It is safe here for a specific reason rather than by exception: rolling back
-- one version returns to code that never issued a query either index could serve, so
-- there is no version of this app that runs slower without them. An index with zero
-- scans has no rollback risk to trade against.
DROP INDEX IF EXISTS "variant_index_sku_lower";
DROP INDEX IF EXISTS "variant_index_title_lower";
