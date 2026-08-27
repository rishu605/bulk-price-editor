-- GIN indexes for the two array columns campaigns scope by.
--
-- Measured on anchor-perf, 102,132 variants: `tags @> ARRAY['clearance']` went from a
-- sequential scan of the whole catalogue to a Bitmap Index Scan at ~20ms. Collections
-- takes the same shape and will use the index whenever the value is selective enough --
-- the sample collection tested covers a large share of the catalogue, so Postgres
-- correctly prefers a scan for that one.
--
-- Expand only: adding an index changes no rows and the previous release simply does not
-- benefit from it. Index build on the 102K table was under a second; on a materially
-- larger catalogue this takes a write lock for the duration, which is the reason to run
-- it during a quiet window rather than mid-campaign.
--
-- Deliberately NOT added: btree indexes on `productType` and `vendor`. Prisma emits
-- `productType ILIKE $1` for those, because `astToWhere` matches them with
-- `mode: "insensitive"` -- and no btree index, including one on `lower(productType)`,
-- serves ILIKE. Two such indexes were created, measured, found unused and dropped before
-- this migration was written. See #160 for what would actually help.
CREATE INDEX IF NOT EXISTS "variant_index_tags_gin" ON "variant_index" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS "variant_index_collections_gin" ON "variant_index" USING GIN ("collections");
