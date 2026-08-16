-- DropIndex
DROP INDEX "variant_index_collections_gin";

-- DropIndex
DROP INDEX "variant_index_tags_gin";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "enrollPendingAt" TIMESTAMP(3);
