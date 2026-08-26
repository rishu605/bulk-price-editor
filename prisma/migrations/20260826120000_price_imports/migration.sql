-- Prices imported from a file, to be applied as a campaign (#228).
--
-- A merchant setting prices from a spreadsheet is doing something a rule cannot express:
-- forty thousand different answers, one per product. The obvious implementation -- read
-- the file, write the prices -- breaks two architectural rules at once: the web process
-- never writes prices, and no price changes without a ledger row a revert can recompute
-- from.
--
-- So the import becomes a campaign whose rule says "look it up here". Everything
-- downstream is unchanged: preview, guardrails, rounding, blast-radius confirmation,
-- per-market surfaces and revert all work, because the rule is just another rule.
--
-- The rows live here rather than in the campaign's JSON because a rule row is stored as
-- JSON on the campaign, and forty thousand prices in a JSON column would be a second copy
-- of the file that can disagree with the first.
--
-- Expand-only: two new tables and their indexes.
CREATE TABLE "price_imports" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,

    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,

    -- Rows read and matched. Kept so the campaign can say where it came from.
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsMatched" INTEGER NOT NULL DEFAULT 0,

    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_imports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "price_import_rows" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,

    "variantGid" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "compareAt" BIGINT,

    CONSTRAINT "price_import_rows_pkey" PRIMARY KEY ("id")
);

-- One price per variant per import. A file naming a variant twice is a question, not two
-- instructions, and the importer refuses it rather than letting the last row win.
CREATE UNIQUE INDEX "price_import_rows_importId_variantGid_key"
  ON "price_import_rows"("importId", "variantGid");
CREATE INDEX "price_imports_shopId_createdAt_idx" ON "price_imports"("shopId", "createdAt");

ALTER TABLE "price_imports" ADD CONSTRAINT "price_imports_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "price_import_rows" ADD CONSTRAINT "price_import_rows_importId_fkey"
  FOREIGN KEY ("importId") REFERENCES "price_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
